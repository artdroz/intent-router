import type { Router, RouteResult } from "./types.js";
import type { Gate } from "../../gates/types.js";
import type { ClassificationResult, ClassificationEntry } from "../classifiers/types.js";
import { KeywordClassifier } from "../classifiers/keyword.js";
import { SemanticClassifier } from "../classifiers/semantic.js";
import { LlmClassifier } from "../classifiers/llm.js";
import { buildResult, computeMargin, computeEntropy, pickBestLabel } from "../utils.js";
import {
  CAS_ENTROPY_THRESHOLD,
  CAS_KEYWORD_GATE_BOOST,
  CAS_KW_WEIGHT,
  CAS_MARGIN_THRESHOLD,
  CAS_SEM_WEIGHT,
} from "../config.js";

export type CascadeOptions = {
  kwWeight?: number;
  semWeight?: number;
  marginThreshold?: number;
  entropyThreshold?: number;
};

export class CascadingRouter implements Router {
  readonly name = "cascade";

  private readonly kwWeight: number;
  private readonly semWeight: number;
  private readonly marginThreshold: number;
  private readonly entropyThreshold: number;

  constructor(
    private keyword: KeywordClassifier,
    private semantic: SemanticClassifier,
    private llm: LlmClassifier,
    private options: CascadeOptions = {},
  ) {
    this.kwWeight = this.options.kwWeight ?? CAS_KW_WEIGHT;
    this.semWeight = this.options.semWeight ?? CAS_SEM_WEIGHT;
    this.marginThreshold = this.options.marginThreshold ?? CAS_MARGIN_THRESHOLD;
    this.entropyThreshold = this.options.entropyThreshold ?? CAS_ENTROPY_THRESHOLD;
  }

  async route(prompt: string, gate: Gate): Promise<RouteResult> {
    // 1. Run keyword + semantic in parallel
    const [kwResult, semResult] = await Promise.all([
      this.keyword.classify(prompt, gate),
      this.semantic.classify(prompt, gate),
    ]);

    // 2. Aggregate weighted scores
    const aggregated = aggregatePrecascade(kwResult, semResult, gate, this.kwWeight, this.semWeight);
    const sorted = [...aggregated.entries()].sort((a, b) => b[1].prob - a[1].prob);

    const margin = computeMargin(sorted);
    const entropy = computeEntropy(aggregated);
    const preCascadeResult: RouteResult = {
      label: sorted[0][0],
      score: sorted[0][1].prob,
      stage: "pre-cascade",
      scores: entriesToScores(aggregated),
    };

    if (!shouldCascade(margin, entropy, this.marginThreshold, this.entropyThreshold)) {
      return preCascadeResult;
    }

    // 3. Low confidence — fall back to LLM
    return this.runLlmFallback(prompt, gate, preCascadeResult);
  }

  private async runLlmFallback(
    prompt: string,
    gate: Gate,
    preCascade: RouteResult,
  ): Promise<RouteResult> {
    const llmResult = await this.llm.classify(prompt, gate);
    const { label, score } = pickBestLabel(llmResult.entries);

    // LLM produced no usable answer — degrade gracefully to pre-cascade
    if (label === null) return preCascade;

    return { label, score, stage: "llm", scores: entriesToScores(llmResult.entries) };
  }
}

/** Decide whether pre-cascade confidence is too low and should fall back to LLM. */
export function shouldCascade(
  margin: number,
  entropy: number,
  marginThreshold: number,
  entropyThreshold: number,
): boolean {
  return margin < marginThreshold || entropy > entropyThreshold;
}

/** Aggregate weighted sum of keyword + semantic probabilities across all gate classes. */
export function aggregatePrecascade(
  kw: ClassificationResult,
  sem: ClassificationResult,
  gate: Gate,
  kwWeight: number,
  semWeight: number,
): Map<string, ClassificationEntry> {
  const scores = new Map<string, number>();
  const evidence = new Map<string, string[]>();

  for (const label of gate.classes.map((c) => c.label)) {
    const entry = scoreClass(kw.entries.get(label), sem.entries.get(label), kwWeight, semWeight);
    scores.set(label, entry.prob);
    evidence.set(label, entry.evidence);
  }

  return buildResult(scores, evidence);
}

/** Calculate weighted per-class score with keyword-gating boost (before normalization). */
export function scoreClass(
  kwEntry: ClassificationEntry | undefined,
  semEntry: ClassificationEntry | undefined,
  kwWeight: number,
  semWeight: number,
): ClassificationEntry {
  const kwScore = kwEntry?.prob ?? 0;
  const semScore = semEntry?.prob ?? 0;

  // When keyword classifier has any matches, multiplies the entire combined score
  // by a multiplier scaled by keyword strength instead of just presence.
  // This multiplier also amplifies the semantic signal, which increase overall confidence.
  const gateMultiplier = 1 + (CAS_KEYWORD_GATE_BOOST - 1) * kwScore;

  const weighted = (kwScore * kwWeight + semScore * semWeight) * gateMultiplier;
  return {
    prob: weighted,
    evidence: [...(kwEntry?.evidence ?? []), ...(semEntry?.evidence ?? [])],
  };
}

/** Flatten a label → entry map into a plain score record. */
export function entriesToScores(entries: Map<string, ClassificationEntry>): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const [label, entry] of entries) {
    scores[label] = entry.prob;
  }
  return scores;
}
