import { randomUUID } from "node:crypto";
import * as gateStore from "../store/gates.js";
import * as routingStore from "../store/routing.js";
import * as embeddingsStore from "../store/embeddings.js";
import { toGate } from "../gates/service.js";
import type { LlmClient } from "../lib/llm-client.js";
import { EmbedClient } from "../lib/embed-client.js";
import { getEmbedClient } from "../lib/embed-client.js";
import { KeywordClassifier, tokenize } from "./classifiers/keyword.js";
import { SemanticClassifier } from "./classifiers/semantic.js";
import { LlmClassifier } from "./classifiers/llm.js";
import { CascadingRouter } from "./router/cascading.js";
import type { RouteResult } from "./router/types.js";
import type { RouteRequest, FeedbackInput } from "./schema.js";
import { LRN_SCORE_THRESHOLD, LRN_MAX_PER_CLASS } from "./config.js";

let _router: CascadingRouter | null = null;

export function initRouter(llmClient: LlmClient, embedClient: EmbedClient) {
  _router = new CascadingRouter(
    new KeywordClassifier(),
    new SemanticClassifier(embedClient),
    new LlmClassifier(llmClient),
  );
}

function getRouter(): CascadingRouter {
  if (!_router) throw new Error("Router not initialized — call initRouter first");
  return _router;
}

export async function route(
  apiKeyId: number,
  input: RouteRequest,
): Promise<{ routeId: string; result: RouteResult }> {
  const rawGate = await gateStore.getGateByName(apiKeyId, input.gate);
  if (!rawGate) throw new Error(`Gate "${input.gate}" not found`);

  const domainGate = toGate(rawGate);

  const router = getRouter();
  const result = await router.route(input.prompt, domainGate);

  // Find the predicted class ID for logging
  const predictedClass = rawGate.classes.find((c) => c.label === result.label);
  const routeId = `r_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  if (predictedClass) {
    await routingStore.insertRouteEvent({
      routeId,
      apiKeyId,
      gateId: rawGate.gate.id,
      prompt: input.prompt,
      predictedClassId: predictedClass.id,
      stage: result.stage,
      scores: result.scores,
    });
  }

  return { routeId, result };
}

export async function submitFeedback(
  input: FeedbackInput,
): Promise<void> {
  const event = await routingStore.getRouteByRouteId(input.routeId);
  if (!event) throw new Error(`Route "${input.routeId}" not found`);

  // Keyword extraction; noise filtering happens in the cron via TF-IDF scoring.
  const tokens = tokenize(event.prompt);
  const keywords = [...tokens].filter((t) => t.length > 2);

  // Persist feedback FIRST — audit trail must survive embedding failures
  await routingStore.insertFeedback(
    input.routeId,
    input.positive ? 1 : 0,
    keywords.length > 0 ? keywords : undefined,
  );

  // Embedding feedback: store positives, NN-delete on negatives
  try {
    const embedding = await getEmbedClient().embed(event.prompt);
    const predictedClass = await gateStore.getClassById(event.predictedClassId);

    if (input.positive) {
      if (predictedClass) {
        await embeddingsStore.insertMany([{
          classId: event.predictedClassId,
          gateName: predictedClass.gateName,
          label: predictedClass.label,
          content: event.prompt,
          source: "feedback",
          embedding,
        }]);
      }
    } else {
      // Delete nearest non-config embedding
      const nearest = await embeddingsStore.searchByClassId(
        event.predictedClassId,
        embedding,
        20,
      );
      const toDelete = nearest.find((r) => r.source !== "config");
      if (toDelete) {
        await embeddingsStore.deleteById(toDelete.id);
      }
    }
  } catch (err) {
    // Feedback already persisted; embedding learning is best-effort
    console.warn("Embedding feedback failed:", err);
  }
}

/**
 * Cron: recalculate promotedKeywords for all classes using TF-IDF scoring.
 *
 * For each gate with feedback:
 *   1. Build corpus: all (classId, keywords, positive) across the gate
 *   2. Compute TF-IDF per keyword per class
 *   3. Promote top-N keywords per class
 */
export async function runKeywordLearning(
  scoreThreshold: number = LRN_SCORE_THRESHOLD,
  maxPerClass: number = LRN_MAX_PER_CLASS,
): Promise<void> {
  const gateIds = await routingStore.getGateIdsWithFeedback();

  for (const gateId of gateIds) {
    const corpus = await routingStore.getFeedbackCorpusByGate(gateId);

    // Index: classId → [{ keywords, positive }]
    const byClass = new Map<number, { keywords: string[]; positive: number }[]>();
    for (const row of corpus) {
      const list = byClass.get(row.classId) ?? [];
      list.push({ keywords: row.keywords ?? [], positive: row.positive });
      byClass.set(row.classId, list);
    }

    const classIds = [...byClass.keys()];
    if (classIds.length < 2) continue; // TF-IDF needs ≥2 classes

    const numClasses = classIds.length;

    // TF(k, c) = docCount(k, c) / totalDocs(c)
    // IDF(k)   = log(numClasses / classesWithKeyword(k))
    // Score(k, c) = TF(k, c) * IDF(k) * avgSignal(k, c)

    // Build DF(k): how many classes contain keyword k
    const docFreq = new Map<string, number>();
    for (const [, docs] of byClass) {
      const seen = new Set<string>();
      for (const doc of docs) {
        for (const kw of doc.keywords) seen.add(kw);
      }
      for (const kw of seen) {
        docFreq.set(kw, (docFreq.get(kw) ?? 0) + 1);
      }
    }

    // Score each keyword per class
    for (const [classId, docs] of byClass) {
      const totalDocs = docs.length;
      if (totalDocs === 0) continue;

      const tfIdf = new Map<string, number>();
      const signalSum = new Map<string, number>();

      for (const doc of docs) {
        const signal = doc.positive === 1 ? 1 : -1;
        for (const kw of doc.keywords) {
          signalSum.set(kw, (signalSum.get(kw) ?? 0) + signal);
        }
      }

      for (const [kw] of signalSum) {
        const posCount = docs.filter((d) => d.keywords.includes(kw) && d.positive === 1).length;
        const negCount = docs.filter((d) => d.keywords.includes(kw) && d.positive === 0).length;
        const tf = docs.filter((d) => d.keywords.includes(kw)).length / totalDocs;
        const idf = Math.log(numClasses / (docFreq.get(kw) ?? 1));
        const signalRatio = (posCount + 1) / (posCount + negCount + 1); // Laplace-smoothed
        tfIdf.set(kw, tf * idf * signalRatio);
      }

      const promoted = [...tfIdf.entries()]
        .filter(([, score]) => score >= scoreThreshold)
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxPerClass)
        .map(([kw]) => kw);

        await routingStore.replacePromotedKeywords(classId, promoted);
    }
  }
}