import type { Router, RouteResult, HistoricalFallback, CascadeOptions } from "./types.js";
import type { Gate } from "../../gates/types.js";
import type {
  Classifier,
  ClassificationResult,
  ClassificationEntry,
} from "../classifiers/types.js";
import { buildResult, computeRelativeMargin, computeEntropy, pickBestLabel } from "../utils.js";
import {
  CAS_ENTROPY_THRESHOLD,
  CAS_KW_WEIGHT,
  CAS_MARGIN_THRESHOLD,
  CAS_SEM_WEIGHT,
  LLM_MAX_ATTEMPTS,
} from "../constants.js";
import { InternalError } from "../../errors.js";

/** Composes the three classifiers: pre-cascade blend, confidence/agreement gates, LLM fallback. */
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
      kwResult: kwResults,
      semResult: semResults,
      sorted: aggregatedResults,
    } = await this.runPrecascade(prompt, gate, tenantId);

    if (
      !shouldCascade(
        aggregatedResults,
        kwResults,
        semResults,
        this.marginThreshold,
        this.entropyThreshold,
      )
    ) {
      return preCascadeResult;
    }

    // Low confidence — fall back to LLM
    return this.runLlmFallback(prompt, gate, preCascadeResult, tenantId);
  }

  async runPrecascade(
    prompt: string,
    gate: Gate,
    tenantId: string,
  ): Promise<{
    result: RouteResult;
    kwResult: ClassificationResult;
    semResult: ClassificationResult;
    sorted: [string, ClassificationEntry][];
  }> {
    const useKeyword = hasConfiguredKeywords(gate);
    const useSemantic = hasConfiguredUtterances(gate);
    let aggregated: Map<string, ClassificationEntry>;
    let kwResult: ClassificationResult = { classifier: "keyword", entries: new Map() };
    let semResult: ClassificationResult = { classifier: "semantic", entries: new Map() };

    // Run only the classifiers that have configured signal, so a missing
    // keyword/utterance config can never produce a bogus all-zero distribution.
    if (useKeyword && useSemantic) {
      [kwResult, semResult] = await Promise.all([
        this.keyword.classify(prompt, gate, tenantId),
        this.semantic.classify(prompt, gate, tenantId),
      ]);
      aggregated = aggregatePrecascade(kwResult, semResult, gate, this.kwWeight, this.semWeight);
    } else if (useKeyword) {
      kwResult = await this.keyword.classify(prompt, gate, tenantId);
      aggregated = ensureAllClasses(kwResult.entries, gate);
    } else {
      semResult = await this.semantic.classify(prompt, gate, tenantId);
      aggregated = ensureAllClasses(semResult.entries, gate);
    }

    const sorted = [...aggregated.entries()].sort((a, b) => b[1].prob - a[1].prob);

    const result: RouteResult = {
      label: sorted[0][0],
      score: sorted[0][1].prob,
      stage: "pre-cascade",
      scores: entriesToScores(aggregated),
      preCascadeScores: entriesToScores(aggregated),
      margin: computeRelativeMargin(sorted),
      entropy: computeEntropy(sorted),
    };

    return { result, kwResult, semResult, sorted };
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
      return {
        label,
        score,
        stage: "llm",
        scores: entriesToScores(llmResult.entries),
        preCascadeScores: preCascade?.preCascadeScores ?? null,
        margin: preCascade?.margin ?? null,
        entropy: preCascade?.entropy ?? null,
      };
    }

    // LLM produced no usable answer — degrade gracefully to pre-cascade.
    if (preCascade) return preCascade;

    // Last resort: the most-frequent historical class for this (gate, tenant).
    const historical = await this.historicalFallback?.(gate, tenantId);
    if (historical) {
      const scores: Record<string, number> = {};
      for (const c of gate.classes) scores[c.label] = c.label === historical ? 1 : 0;
      return {
        label: historical,
        score: 0,
        stage: "historical",
        scores,
        preCascadeScores: null,
        margin: null,
        entropy: null,
      };
    }

    throw new InternalError(
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
  aggregatedResults: [string, ClassificationEntry][],
  kwResults: ClassificationResult,
  semResults: ClassificationResult,
  marginThreshold: number,
  entropyThreshold: number,
): boolean {
  // Margin gates the gap between the #1 and #2 classes.
  // Entropy gates how spread the probability is across all classes.
  const margin = computeRelativeMargin(aggregatedResults);
  const entropy = computeEntropy(aggregatedResults);
  if (margin < marginThreshold || entropy > entropyThreshold) return true;

  // Confident disagreement: each classifier individually sure, but about
  // different classes → contradictory evidence → cascade regardless of the blend.
  const sortedKwResults = [...kwResults.entries].sort((a, b) => b[1].prob - a[1].prob);
  const sortedSemResults = [...semResults.entries].sort((a, b) => b[1].prob - a[1].prob);
  const kwMargin = computeRelativeMargin(sortedKwResults);
  const semMargin = computeRelativeMargin(sortedSemResults);
  const kwTop = sortedKwResults[0]?.[0] ?? null;
  const semTop = sortedSemResults[0]?.[0] ?? null;
  const kwConfident = kwTop !== null && kwMargin >= marginThreshold;
  const semConfident = semTop !== null && semMargin >= marginThreshold;

  if (kwConfident && semConfident && kwTop !== semTop) return true;

  return false;
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

/** Calculate weighted per-class score (linear keyword + semantic blend, before normalization). */
export function scoreClass(
  kwEntry: ClassificationEntry | undefined,
  semEntry: ClassificationEntry | undefined,
  kwWeight: number,
  semWeight: number,
): ClassificationEntry {
  const kwScore = kwEntry?.prob ?? 0;
  const semScore = semEntry?.prob ?? 0;

  // Linear blend only — the keyword stage already weights configured (2.0)
  // versus promoted (1.0) keywords internally.
  const weighted = kwScore * kwWeight + semScore * semWeight;
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
