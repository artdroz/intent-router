import type { Router, RouteResult, HistoricalFallback, CascadeOptions } from "./types.js";
import type { Gate } from "../../gates/types.js";
import type {
  Classifier,
  ClassificationResult,
  ClassificationEntry,
} from "../classifiers/types.js";
import { buildResult, computeMargin, computeEntropy, pickBestLabel } from "../utils.js";
import {
  CAS_ENTROPY_THRESHOLD,
  CAS_KEYWORD_GATE_BOOST,
  CAS_KW_WEIGHT,
  CAS_MARGIN_THRESHOLD,
  CAS_SEM_WEIGHT,
  LLM_MAX_ATTEMPTS,
} from "../config.js";

export class CascadingRouter implements Router {
  readonly name = "cascade";

  private readonly kwWeight: number;
  private readonly semWeight: number;
  private readonly marginThreshold: number;
  private readonly entropyThreshold: number;

  constructor(
    private keyword: Classifier,
    private semantic: Classifier,
    private llm: Classifier,
    private options: CascadeOptions = {},
    // historicalFallback is passed in as a function for testability
    private historicalFallback?: HistoricalFallback,
  ) {
    this.kwWeight = this.options.kwWeight ?? CAS_KW_WEIGHT;
    this.semWeight = this.options.semWeight ?? CAS_SEM_WEIGHT;
    this.marginThreshold = this.options.marginThreshold ?? CAS_MARGIN_THRESHOLD;
    this.entropyThreshold = this.options.entropyThreshold ?? CAS_ENTROPY_THRESHOLD;
  }

  async route(prompt: string, gate: Gate, tenantId: string): Promise<RouteResult> {
    // Safety net: with no keyword or utterance signal configured, the
    // pre-cascade has nothing to work with — go straight to the LLM.
    if (!hasConfiguredKeywords(gate) && !hasConfiguredUtterances(gate)) {
      return this.runLlmFallback(prompt, gate, null, tenantId);
    }

    const {
      result: preCascadeResult,
      margin,
      entropy,
    } = await this.runPrecascade(prompt, gate, tenantId);

    if (!shouldCascade(margin, entropy, this.marginThreshold, this.entropyThreshold)) {
      return preCascadeResult;
    }

    // Low confidence — fall back to LLM
    return this.runLlmFallback(prompt, gate, preCascadeResult, tenantId);
  }

  async runPrecascade(
    prompt: string,
    gate: Gate,
    tenantId: string,
  ): Promise<{ result: RouteResult; margin: number; entropy: number }> {
    const useKeyword = hasConfiguredKeywords(gate);
    const useSemantic = hasConfiguredUtterances(gate);
    let aggregated: Map<string, ClassificationEntry>;

    // Run only the classifiers that have configured signal, so a missing
    // keyword/utterance config can never produce a bogus all-zero distribution.
    if (useKeyword && useSemantic) {
      const [kwResult, semResult] = await Promise.all([
        this.keyword.classify(prompt, gate, tenantId),
        this.semantic.classify(prompt, gate, tenantId),
      ]);
      aggregated = aggregatePrecascade(kwResult, semResult, gate, this.kwWeight, this.semWeight);
    } else if (useKeyword) {
      const kwResult = await this.keyword.classify(prompt, gate, tenantId);
      aggregated = ensureAllClasses(kwResult.entries, gate);
    } else {
      const semResult = await this.semantic.classify(prompt, gate, tenantId);
      aggregated = ensureAllClasses(semResult.entries, gate);
    }

    const sorted = [...aggregated.entries()].sort((a, b) => b[1].prob - a[1].prob);

    const margin = computeMargin(sorted);
    const entropy = computeEntropy(aggregated);

    const result: RouteResult = {
      label: sorted[0][0],
      score: sorted[0][1].prob,
      stage: "pre-cascade",
      scores: entriesToScores(aggregated),
    };

    return { result, margin, entropy };
  }

  private async runLlmFallback(
    prompt: string,
    gate: Gate,
    preCascade: RouteResult | null,
    tenantId: string,
  ): Promise<RouteResult> {
    const llmResult = await this.classifyLlmWithRetry(prompt, gate, tenantId);
    const { label, score } = pickBestLabel(llmResult.entries);

    if (label !== null) {
      return { label, score, stage: "llm", scores: entriesToScores(llmResult.entries) };
    }

    // LLM produced no usable answer — degrade gracefully to pre-cascade.
    if (preCascade) return preCascade;

    // Last resort: the most-frequent historical class for this (gate, tenant).
    const historical = await this.historicalFallback?.(gate, tenantId);
    if (historical) {
      const scores: Record<string, number> = {};
      for (const c of gate.classes) scores[c.label] = c.label === historical ? 1 : 0;
      return { label: historical, score: 0, stage: "historical", scores };
    }

    throw new Error(
      `Gate "${gate.name}" could not be classified: LLM returned no usable answer and no fallback is available`,
    );
  }

  /**
   * Call the LLM up to {@link LLM_MAX_ATTEMPTS} times, retrying only when the
   * previous attempt produced no usable label (empty or all-zero distribution).
   */
  private async classifyLlmWithRetry(
    prompt: string,
    gate: Gate,
    tenantId: string,
  ): Promise<ClassificationResult> {
    let last: ClassificationResult | null = null;

    for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
      const result = await this.llm.classify(prompt, gate, tenantId);
      last = result;
      if (pickBestLabel(result.entries).label !== null) return result;
    }
    return last!;
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

/** True when at least one class has config keywords for the keyword classifier. */
export function hasConfiguredKeywords(gate: Gate): boolean {
  return gate.classes.some((c) => c.keywords.length > 0);
}

/** True when at least one class has config utterances for the semantic classifier. */
export function hasConfiguredUtterances(gate: Gate): boolean {
  return gate.classes.some((c) => c.utterances.length > 0);
}

/** Fill in any gate classes missing from a single-classifier distribution with prob 0. */
function ensureAllClasses(
  entries: Map<string, ClassificationEntry>,
  gate: Gate,
): Map<string, ClassificationEntry> {
  const complete = new Map(entries);
  for (const c of gate.classes) {
    if (!complete.has(c.label)) {
      complete.set(c.label, { prob: 0, evidence: [] });
    }
  }
  return complete;
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
