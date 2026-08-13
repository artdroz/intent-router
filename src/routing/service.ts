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
import type { RoutingEventRow } from "../store/schema.js";
import { LRN_SCORE_THRESHOLD, LRN_MAX_PER_CLASS } from "./config.js";
import { groupCorpusByClass, computeDocFrequencies, scoreClassKeywords } from "./tfidf.js";

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

export type FeedbackDeps = {
  getRouteByRouteId: typeof routingStore.getRouteByRouteId;
  insertFeedback: typeof routingStore.insertFeedback;
  getClassById: typeof gateStore.getClassById;
  embed: (text: string) => Promise<number[]>;
  insertMany: typeof embeddingsStore.insertMany;
  searchByClassId: typeof embeddingsStore.searchByClassId;
  deleteById: typeof embeddingsStore.deleteById;
};

const defaultFeedbackDeps: FeedbackDeps = {
  getRouteByRouteId: routingStore.getRouteByRouteId,
  insertFeedback: routingStore.insertFeedback,
  getClassById: gateStore.getClassById,
  embed: (text) => getEmbedClient().embed(text),
  insertMany: embeddingsStore.insertMany,
  searchByClassId: embeddingsStore.searchByClassId,
  deleteById: embeddingsStore.deleteById,
};

export async function submitFeedback(
  input: FeedbackInput,
  deps: FeedbackDeps = defaultFeedbackDeps,
): Promise<void> {
  const event = await deps.getRouteByRouteId(input.routeId);
  if (!event) throw new Error(`Route "${input.routeId}" not found`);

  // Keyword extraction; noise filtering happens in the cron via TF-IDF scoring.
  const tokens = tokenize(event.prompt);
  const keywords = [...tokens].filter((t) => t.length > 2);

  // Persist feedback FIRST — audit trail must survive embedding failures
  await deps.insertFeedback(
    input.routeId,
    input.positive ? 1 : 0,
    keywords.length > 0 ? keywords : undefined,
  );

  await applyEmbeddingFeedback(event, input, deps);
}

async function applyEmbeddingFeedback(
  event: RoutingEventRow,
  input: FeedbackInput,
  deps: FeedbackDeps,
): Promise<void> {
  try {
    const embedding = await deps.embed(event.prompt);
    const predictedClass = await deps.getClassById(event.predictedClassId);

    // Store positives
    if (input.positive) {
      if (predictedClass) {
        await deps.insertMany([
          {
            classId: event.predictedClassId,
            gateName: predictedClass.gateName,
            label: predictedClass.label,
            content: event.prompt,
            source: "feedback",
            embedding,
          },
        ]);
      }
      return;
    }

    // NN-delete the nearest non-config embedding
    const nearest = await deps.searchByClassId(event.predictedClassId, embedding, 20);
    const toDelete = nearest.find((r) => r.source !== "config");
    if (toDelete) {
      await deps.deleteById(toDelete.id);
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
export async function promoteKeyword(
  scoreThreshold: number = LRN_SCORE_THRESHOLD,
  maxPerClass: number = LRN_MAX_PER_CLASS,
): Promise<void> {
  const gateIds = await routingStore.getGateIdsWithFeedback();

  for (const gateId of gateIds) {
    const corpus = await routingStore.getFeedbackCorpusByGate(gateId);
    const byClass = groupCorpusByClass(corpus);
    const classIds = [...byClass.keys()];
    if (classIds.length < 2) continue; // TF-IDF needs ≥2 classes

    const docFreq = computeDocFrequencies(byClass);

    for (const [classId, docs] of byClass) {
      const promoted = scoreClassKeywords(
        docs,
        docFreq,
        classIds.length,
        scoreThreshold,
        maxPerClass,
      );
      await routingStore.replacePromotedKeywords(classId, promoted);
    }
  }
}
