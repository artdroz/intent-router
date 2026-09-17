import { randomUUID } from "node:crypto";
import * as gateStore from "../store/gates.js";
import * as routingStore from "../store/routing.js";
import * as embeddingsStore from "../store/embeddings.js";
import { toGate } from "../gates/service.js";
import type { LlmClient } from "../clients/llm-client.js";
import { getEmbedClient, type EmbedClient } from "../clients/embed-client.js";
import { KeywordClassifier, tokenize } from "./classifiers/keyword.js";
import { SemanticClassifier } from "./classifiers/semantic.js";
import { LlmClassifier } from "./classifiers/llm.js";
import { CascadingRouter } from "./router/cascading.js";
import type { RouteResult } from "./router/types.js";
import type { RouteRequest, FeedbackInput } from "./schema.js";
import type { EmbeddingSource, RoutingEventRow } from "../store/schema.js";
import {
  LRN_SCORE_THRESHOLD,
  LRN_MAX_PER_CLASS,
  LRN_MIN_FEEDBACK_ROWS,
  LRN_NEG_MARGIN,
  MARGIN_EPSILON,
} from "./constants.js";
import { groupCorpusByClass, computeDocFrequencies, scoreClassKeywords } from "./tfidf.js";
import { roundScoreMap, roundTo } from "./utils.js";
import { InternalError, NotFoundError, ValidationError } from "../errors.js";

let router: CascadingRouter | null = null;
let maxPromptLength = 50000;

/**
 * Initialize the process-wide router with the three classifiers and a
 * historical fallback. Called once at bootstrap before any routing request.
 */
export function initRouter(llmClient: LlmClient, embedClient: EmbedClient, maxPromptLen: number) {
  maxPromptLength = maxPromptLen;
  router = new CascadingRouter(
    new KeywordClassifier(),
    new SemanticClassifier(embedClient),
    new LlmClassifier(llmClient),
    {},
    (gate, tenantId) => routingStore.getMostFrequentClass(tenantId, gate.id),
  );
}

function getRouter(): CascadingRouter {
  if (!router) throw new InternalError("Router not initialized — call initRouter first");
  return router;
}

/** Which entry point produced a routing request; recorded in `routing_events.channel`. */
export type RoutingChannel = "rest" | "litellm" | "mcp";

/**
 * Route a prompt to an intent within the tenant's gate and persist the event.
 * Returns a public `routeId` for later feedback plus the routing decision.
 */
export async function route(
  tenantId: string,
  input: RouteRequest,
  channel: RoutingChannel = "litellm",
): Promise<{ routeId: string; result: RouteResult }> {
  if (input.prompt.length > maxPromptLength) {
    throw new ValidationError(`Prompt exceeds max length of ${maxPromptLength}`);
  }

  // Check if the tenant has access to the gate
  const visibleGates = await gateStore.getGatesByTenant(tenantId);

  const rawGate = visibleGates.find((g) => g.gate.name === input.gate);
  if (!rawGate) throw new NotFoundError(`Gate "${input.gate}" not found`);

  const domainGate = toGate(rawGate);

  const activeRouter = getRouter();
  const result = await activeRouter.route(input.prompt, domainGate, tenantId);

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
      scores: result.preCascadeScores,
      margin: result.margin,
      entropy: result.entropy,
      channel,
    });
  }

  // Round scores only for the caller. The full-precision distribution is
  // already persisted above, and the learning math (top-2 margin gating)
  // depends on the raw values.
  return {
    routeId,
    result: {
      ...result,
      score: roundTo(result.score),
      scores: roundScoreMap(result.scores),
    },
  };
}

/** Persist user feedback for a routing decision and apply best-effort learning. */
export async function submitFeedback(input: FeedbackInput, tenantId: string): Promise<void> {
  // Only the tenant that created the route may submit feedback for it.
  const event = await routingStore.getRouteByRouteId(input.routeId);
  if (!event || event.tenantId !== tenantId) {
    throw new NotFoundError(`Route "${input.routeId}" not found`);
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

  // Fire-and-forget: the feedback row is already durable, so respond without
  // waiting for the embedding write. applyEmbeddingFeedback swallows its own
  // failures; the evidence is recoverable from the feedback row if needed.
  void applyEmbeddingFeedback(event, input);
}

/**
 * Best-effort embedding learning from feedback:
 * - positive → store the prompt as a tenant learned embedding
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
    // A route whose tenant or class was deleted (FK set NULL) cannot be
    // attributed for learning — skip embedding feedback for it.
    if (event.tenantId === null || event.predictedClassId === null) return;

    const embedding = await getEmbedClient().embed(event.prompt);
    const predictedClass = await gateStore.getClassById(event.predictedClassId);
    if (!predictedClass) return;

    // Only learn from confident errors. LLM/historical stages commit to a bare
    // label (no distribution), so any miss there is a confident error. A
    // pre-cascade miss is confident only when the top-2 margin is large enough;
    // a flat distribution means the error was ambiguous noise.
    if (!input.positive && event.stage === "pre-cascade") {
      const margin = topTwoMargin(event.scores);
      if (margin === null || margin < LRN_NEG_MARGIN - MARGIN_EPSILON) return;
    }

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

/** Top-2 probability margin of a route's score distribution (null when unavailable). */
function topTwoMargin(scores: unknown): number | null {
  const values = Object.values((scores ?? {}) as Record<string, number>);
  if (values.length < 2) return null;
  const sorted = [...values].sort((a, b) => b - a);
  return sorted[0] - sorted[1];
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
    if (corpus.length < LRN_MIN_FEEDBACK_ROWS) continue; // not enough signal yet

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
