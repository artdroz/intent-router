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
import type { EmbeddingSource, RoutingEventRow } from "../store/schema.js";
import { LRN_SCORE_THRESHOLD, LRN_MAX_PER_CLASS } from "./config.js";
import { groupCorpusByClass, computeDocFrequencies, scoreClassKeywords } from "./tfidf.js";

// TOD0: handle large prompts gracefuly when embedding
let _router: CascadingRouter | null = null;
let _maxPromptLength = 50000;

export function initRouter(
  llmClient: LlmClient,
  embedClient: EmbedClient,
  maxPromptLength: number,
) {
  _maxPromptLength = maxPromptLength;
  _router = new CascadingRouter(
    new KeywordClassifier(),
    new SemanticClassifier(embedClient),
    new LlmClassifier(llmClient),
    {},
    (gate, tenantId) => routingStore.getMostFrequentClass(tenantId, gate.id),
  );
}

function getRouter(): CascadingRouter {
  if (!_router) throw new Error("Router not initialized — call initRouter first");
  return _router;
}

export type RoutingChannel = "rest" | "litellm" | "mcp";

export async function route(
  tenantId: string,
  input: RouteRequest,
  channel: RoutingChannel = "litellm",
): Promise<{ routeId: string; result: RouteResult }> {
  if (input.prompt.length > _maxPromptLength) {
    throw new Error(`Prompt exceeds max length of ${_maxPromptLength}`);
  }

  // Check if the tenant has access to the gate
  const visibleGates = await gateStore.getGatesByTenant(tenantId);

  const rawGate = visibleGates.find((g) => g.gate.name === input.gate);
  if (!rawGate) throw new Error(`Gate "${input.gate}" not found`);

  const domainGate = toGate(rawGate);

  const router = getRouter();
  const result = await router.route(input.prompt, domainGate, tenantId);

  // Find the predicted class ID for logging
  const predictedClass = rawGate.classes.find((c) => c.label === result.label);
  const routeId = `r_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  if (predictedClass) {
    await routingStore.insertRouteEvent({
      routeId,
      tenantId,
      gateId: rawGate.gate.id,
      prompt: input.prompt,
      predictedClassId: predictedClass.id,
      stage: result.stage,
      scores: result.scores,
      channel,
    });
  }

  return { routeId, result };
}

export async function submitFeedback(input: FeedbackInput, tenantId: string): Promise<void> {
  // Only the tenant that created the route may submit feedback for it.
  const event = await routingStore.getRouteByRouteId(input.routeId);
  if (!event || event.tenantId !== tenantId) {
    throw new Error(`Route "${input.routeId}" not found`);
  }

  // Keyword extraction; noise filtering happens in the cron via TF-IDF scoring.
  const tokens = tokenize(event.prompt);
  const keywords = [...tokens].filter((t) => t.length > 2);

  // Persist feedback FIRST — audit trail must survive embedding failures
  await routingStore.insertFeedback(
    input.routeId,
    input.positive ? 1 : 0,
    keywords.length > 0 ? keywords : undefined,
  );

  await applyEmbeddingFeedback(event, input);
}

/**
 * Best-effort embedding learning from feedback:
 * - positive → store the prompt as a tenant learnt embedding
 *   (`source: "pos_feedback"`).
 * - negative → store it as a negative guardrail (`source: "neg_feedback"`)
 *   tagged with the wrongly-predicted intent. At runtime a matching guardrail
 *   vetoes that intent (see SemanticClassifier).
 *
 * Each write also removes the opposite-signed embedding for the same utterance
 * so contradictory evidence can't coexist (e.g. a stale guardrail that would
 * keep vetoing an intent the user has now confirmed). Failure is non-fatal —
 * feedback is already persisted.
 */
async function applyEmbeddingFeedback(event: RoutingEventRow, input: FeedbackInput): Promise<void> {
  try {
    const embedding = await getEmbedClient().embed(event.prompt);
    const predictedClass = await gateStore.getClassById(event.predictedClassId);
    if (!predictedClass) return;

    const source: EmbeddingSource = input.positive ? "pos_feedback" : "neg_feedback";
    const opposite: EmbeddingSource = input.positive ? "neg_feedback" : "pos_feedback";

    // Sign flip: clear the opposite-signed evidence for this utterance first.
    await embeddingsStore.deleteBySource(
      event.tenantId,
      event.predictedClassId,
      event.prompt,
      opposite,
    );

    await embeddingsStore.insertMany([
      {
        tenantId: event.tenantId,
        classId: event.predictedClassId,
        gateName: predictedClass.gateName,
        label: predictedClass.label,
        content: event.prompt,
        source,
        embedding,
      },
    ]);
  } catch (err) {
    // Feedback already persisted; embedding learning is best-effort
    console.warn("Embedding feedback failed:", err);
  }
}

/**
 * Cron: recalculate promotedKeywords for all classes using TF-IDF scoring.
 *
 * For each tenant-gate pair with feedback:
 *   1. Build corpus: all (classId, keywords, positive) for that tenant on that gate
 *   2. Compute TF-IDF per keyword per class
 *   3. Promote top-N keywords per class
 */
export async function promoteKeyword(
  scoreThreshold: number = LRN_SCORE_THRESHOLD,
  maxPerClass: number = LRN_MAX_PER_CLASS,
): Promise<void> {
  const scopes = await routingStore.getTenantGatesWithFeedback();

  for (const { tenantId, gateId } of scopes) {
    const corpus = await routingStore.getFeedbackCorpusByTenantGate(tenantId, gateId);
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
      await routingStore.updatePromotedKeywords(classId, tenantId, promoted);
    }
  }
}
