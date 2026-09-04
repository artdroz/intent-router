import type {
  Classifier,
  ClassificationResult,
  ClassificationEntry,
} from "./types.js";
import type { EmbedClient } from "../../lib/embed-client.js";
import type { Gate } from "../../gates/types.js";
import {
  LRN_MIN_VOTES,
  LRN_SEM_VETO_MARGIN,
  LRN_SEM_VETO_THRESHOLD,
  SEM_CONFIG_WEIGHT,
  SEM_FEEDBACK_WEIGHT,
  SEM_SIMILARITY_THRESHOLD,
  SEM_TOP_K,
  SEM_CONF_SCORE_THRESHOLD,
  SEM_CONF_MARGIN_THRESHOLD,
  SEM_CONF_TOP_K,
} from "../config.js";
import { buildResult, computeConfidence } from "../utils.js";
import { searchByGate } from "../../store/embeddings.js";
import type { SearchResult } from "../../store/embeddings.js";

export type SemanticOptions = {
  topK?: number;
  similarityThreshold?: number;
  configWeight?: number;
  feedbackWeight?: number;
  /** Number of top similarities averaged per class (mean of top-K). */
  confTopK?: number;
  scoreThreshold?: number;
  marginThreshold?: number;
};

export class SemanticClassifier implements Classifier {
  readonly name = "semantic" as const;

  private topK: number;
  private similarityThreshold: number;
  private configWeight: number;
  private feedbackWeight: number;
  private confTopK: number;
  private scoreThreshold: number;
  private marginThreshold: number;

  constructor(
    private embedClient: EmbedClient,
    opts?: SemanticOptions,
  ) {
    this.topK = opts?.topK ?? SEM_TOP_K;
    this.similarityThreshold = opts?.similarityThreshold ?? SEM_SIMILARITY_THRESHOLD;
    this.configWeight = opts?.configWeight ?? SEM_CONFIG_WEIGHT;
    this.feedbackWeight = opts?.feedbackWeight ?? SEM_FEEDBACK_WEIGHT;
    this.confTopK = opts?.confTopK ?? SEM_CONF_TOP_K;
    this.scoreThreshold = opts?.scoreThreshold ?? SEM_CONF_SCORE_THRESHOLD;
    this.marginThreshold = opts?.marginThreshold ?? SEM_CONF_MARGIN_THRESHOLD;
  }

  async classify(prompt: string, gate: Gate, tenantId: string): Promise<ClassificationResult> {
    const { scores, evidence } = await semanticRawScores(
      prompt,
      gate,
      tenantId,
      this.embedClient,
      this.topK,
      this.similarityThreshold,
      this.configWeight,
      this.feedbackWeight,
      this.confTopK,
    );

    const entries = buildResult(scores, evidence);

    // No positive evidence above the similarity threshold → spread the
    // probability uniformly over all classes (label is arbitrary, and the
    // classifier is not confident, so the cascade defers to the LLM anyway).
    if (entries.size === 0) {
      const uniform = new Map<string, ClassificationEntry>();
      const p = gate.classes.length > 0 ? 1 / gate.classes.length : 0;
      for (const c of gate.classes) uniform.set(c.label, { prob: p, evidence: [] });
      return {
        classifier: "semantic",
        entries: uniform,
        confScore: 0,
        isConfident: false,
      };
    }

    return {
      classifier: "semantic",
      entries,
      ...confidenceFromScores(scores, this.scoreThreshold, this.marginThreshold),
    };
  }
}

/** Source tag for negative guardrail embeddings (explicit-veto evidence). */
const NEG_FEEDBACK_SOURCE = "neg_feedback";

/**
 * Return the set of intent labels vetoed by negative guardrails in the ANN
 * results. A guardrail fires only when its similarity (`1 - distance`) is at
 * or above the threshold — a distant guardrail must not veto anything.
 */
export function detectVetoedLabels(
  rows: SearchResult[],
): Set<string> {
  const minVotes = LRN_MIN_VOTES;
  const vetoThreshold = LRN_SEM_VETO_THRESHOLD;
  const margin = LRN_SEM_VETO_MARGIN;

  const guardrailVotes = new Map<string, number[]>();
  const bestPositive = new Map<string, number>();

  for (const row of rows) {
    const sim = 1 - row.distance;
    if (row.source === NEG_FEEDBACK_SOURCE) {
      if (sim >= vetoThreshold) {
        const votes = guardrailVotes.get(row.label) ?? [];
        votes.push(sim);
        guardrailVotes.set(row.label, votes);
      }
    } else {
      bestPositive.set(row.label, Math.max(bestPositive.get(row.label) ?? 0, sim));
    }
  }

  const vetoed = new Set<string>();
  for (const [label, votes] of guardrailVotes) {
    if (votes.length < minVotes) continue;
    const topVote = Math.max(...votes);
    if (topVote - (bestPositive.get(label) ?? 0) >= margin) vetoed.add(label);
  }
  return vetoed;
}

/** Raw per-class scoring result. */
export type SemanticScoring = {
  scores: Map<string, number>;
  evidence: Map<string, string[]>;
};

/**
 * Embed + ANN search + explicit veto + per-class raw scores. Shared by the
 * classifier and the threshold tuner, so the scoring formula lives in one
 * place. Confidence thresholds are intentionally not applied here.
 */
export async function semanticRawScores(
  prompt: string,
  gate: Gate,
  tenantId: string,
  embed: { embed(text: string): Promise<number[]> },
  topK: number,
  similarityThreshold: number,
  configWeight: number,
  feedbackWeight: number,
  confTopK: number,
): Promise<SemanticScoring> {
  const embedding = await embed.embed(prompt);
  const rows = await searchByGate(gate.name, tenantId, embedding, topK);

  // Explicit veto: a negative guardrail within the similarity threshold vetoes
  // its intent, removing it from the semantic distribution so the cascade falls
  // back to the 2nd-best intent or the LLM.
  const vetoed = detectVetoedLabels(rows);
  const scorable = vetoed.size > 0 ? rows.filter((r) => !vetoed.has(r.label)) : rows;

  return computeSemanticScores(scorable, similarityThreshold, configWeight, feedbackWeight, confTopK);
}

/**
 * Per-class raw score = mean of the top-K weighted similarities (zero-padded),
 * so a class with a few strong neighbours is not over-credited by a sum.
 */
export function computeSemanticScores(
  rows: SearchResult[],
  similarityThreshold: number,
  configWeight: number,
  feedbackWeight: number,
  confTopK: number = SEM_CONF_TOP_K,
): SemanticScoring {
  const scorable = rows.filter((r) => r.source !== NEG_FEEDBACK_SOURCE);

  const perClass = new Map<string, number[]>();
  const evidence = new Map<string, string[]>();

  for (const row of scorable) {
    // pgvector `<=>` returns cosine DISTANCE (0 = identical, 2 = opposite).
    // Convert to similarity first, then apply the similarity threshold.
    const sim = 1 - row.distance;
    if (sim < similarityThreshold) continue;

    const multiplier = row.source === "config" ? configWeight : feedbackWeight;
    const weighted = sim * multiplier;

    const list = perClass.get(row.label) ?? [];
    list.push(weighted);
    perClass.set(row.label, list);

    const ev = evidence.get(row.label) ?? [];
    ev.push(row.content);
    evidence.set(row.label, ev);
  }

  const scores = new Map<string, number>();
  for (const [label, list] of perClass) {
    const topK = [...list].sort((a, b) => b - a);
    let sum = 0;
    for (let i = 0; i < confTopK; i++) sum += topK[i] ?? 0;
    scores.set(label, confTopK > 0 ? sum / confTopK : 0);
  }

  return { scores, evidence };
}

/** Confidence from raw per-class scores (strength = top score, margin = gap). */
export function confidenceFromScores(
  scores: Map<string, number>,
  scoreThreshold: number,
  marginThreshold: number,
): { confScore: number; isConfident: boolean } {
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  if (!top) return { confScore: 0, isConfident: false };

  const topScore = top[1];
  const secondScore = sorted[1]?.[1] ?? 0;
  const margin = topScore - secondScore;
  const confScore = computeConfidence(topScore, scoreThreshold, margin, marginThreshold);
  return { confScore, isConfident: confScore >= 1 };
}

/**
 * Aggregate ANN rows into a ClassificationResult (used by tests and the
 * classifier's raw-scoring path).
 */
export function aggregateSemantic(
  rows: SearchResult[],
  similarityThreshold: number,
  configWeight: number,
  feedbackWeight: number,
  confTopK: number = SEM_CONF_TOP_K,
  scoreThreshold: number = SEM_CONF_SCORE_THRESHOLD,
  marginThreshold: number = SEM_CONF_MARGIN_THRESHOLD,
): ClassificationResult {
  const { scores, evidence } = computeSemanticScores(
    rows,
    similarityThreshold,
    configWeight,
    feedbackWeight,
    confTopK,
  );
  const entries = buildResult(scores, evidence);
  return {
    classifier: "semantic",
    entries,
    ...confidenceFromScores(scores, scoreThreshold, marginThreshold),
  };
}
