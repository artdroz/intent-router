import type { Router, RouteResult, HistoricalFallback, CascadeOptions } from "./types.js";
import type { Gate } from "../../gates/types.js";
import type {
  Classifier,
  ClassificationResult,
  ClassificationEntry,
} from "../classifiers/types.js";
import { buildResult, pickBestLabel } from "../utils.js";
import {
  CAS_KW_WEIGHT,
  CAS_SEM_WEIGHT,
  LLM_MAX_ATTEMPTS,
} from "../config.js";

export class CascadingRouter implements Router {
  readonly name = "cascade";

  private readonly kwWeight: number;
  private readonly semWeight: number;

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
  }

  async route(prompt: string, gate: Gate, tenantId: string): Promise<RouteResult> {
    // Safety net: with no keyword or utterance signal configured, the
    // pre-cascade has nothing to work with — go straight to the LLM.
    if (!hasConfiguredKeywords(gate) && !hasConfiguredUtterances(gate)) {
      return this.runLlmFallback(prompt, gate, null, tenantId);
    }

    const { kwResult, semResult } = await this.runPrecascade(prompt, gate, tenantId);
    const decision = resolvePrecascade(kwResult, semResult, gate, this.kwWeight, this.semWeight);

    if (decision.cascade) {
      const fallback: RouteResult | null =
        decision.label !== null
          ? {
              label: decision.label,
              score: decision.score,
              stage: "pre-cascade",
              scores: decision.scores,
              confScore: decision.confScore,
            }
          : null;
      return this.runLlmFallback(prompt, gate, fallback, tenantId);
    }

    return {
      label: decision.label!,
      score: decision.score,
      stage: "pre-cascade",
      scores: decision.scores,
      confScore: decision.confScore,
    };
  }

  async runPrecascade(
    prompt: string,
    gate: Gate,
    tenantId: string,
  ): Promise<{ result: RouteResult; kwResult: ClassificationResult; semResult: ClassificationResult; sorted: [string, ClassificationEntry][]; }> {
    const useKeyword = hasConfiguredKeywords(gate);
    const useSemantic = hasConfiguredUtterances(gate);
    let aggregated: Map<string, ClassificationEntry>;
    let kwResult: ClassificationResult = {
      classifier: "keyword",
      entries: new Map(),
      confScore: 0,
      isConfident: false,
    };
    let semResult: ClassificationResult = {
      classifier: "semantic",
      entries: new Map(),
      confScore: 0,
      isConfident: false,
    };

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

    const confScore =
      useKeyword && useSemantic
        ? Math.min(kwResult.confScore, semResult.confScore)
        : useKeyword
          ? kwResult.confScore
          : semResult.confScore;

    const result: RouteResult = {
      label: sorted[0][0],
      score: sorted[0][1].prob,
      stage: "pre-cascade",
      scores: entriesToScores(aggregated),
      confScore,
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
        confScore: llmResult.confScore,
      };
    }

    // LLM produced no usable answer — degrade gracefully to pre-cascade.
    if (preCascade) return preCascade;

    // Last resort: the most-frequent historical class for this (gate, tenant).
    const historical = await this.historicalFallback?.(gate, tenantId);
    if (historical) {
      const scores: Record<string, number> = {};
      for (const c of gate.classes) scores[c.label] = c.label === historical ? 1 : 0;
      return { label: historical, score: 0, stage: "historical", scores, confScore: 0 };
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

/** Decision for the pre-cascade stage, derived from each classifier's own gate. */
export type PrecascadeDecision = {
  cascade: boolean;
  label: string | null;
  score: number;
  confScore: number;
  scores: Record<string, number>;
};

/**
 * Combine the keyword and semantic deferral votes. Semantic is the primary
 * gate: a single confident semantic classifier is trusted even when the
 * keyword argmax disagrees, while keyword is advisory and is trusted alone
 * only when semantic has no signal or its argmax agrees.
 *   both confident + agree    → use blended label
 *   both confident + disagree → cascade (contradiction)
 *   one confident + agree     → use that classifier's label
 *   one confident + disagree  → semantic: use it · keyword: cascade
 *   neither confident         → cascade
 */
export function resolvePrecascade(
  kwResult: ClassificationResult,
  semResult: ClassificationResult,
  gate: Gate,
  kwWeight: number,
  semWeight: number,
): PrecascadeDecision {
  const kwTop = topEntry(kwResult.entries);
  const semTop = topEntry(semResult.entries);
  const kwLabel = kwTop?.[0] ?? null;
  const semLabel = semTop?.[0] ?? null;

  const kwConfident = kwResult.isConfident;
  const semConfident = semResult.isConfident;

  if (kwConfident && semConfident) {
    if (kwLabel !== null && kwLabel === semLabel) {
      const aggregated = aggregatePrecascade(kwResult, semResult, gate, kwWeight, semWeight);
      const sorted = [...aggregated.entries()].sort((a, b) => b[1].prob - a[1].prob);
      const top = sorted[0];
      return {
        cascade: false,
        label: top[0],
        score: top[1].prob,
        confScore: Math.min(kwResult.confScore, semResult.confScore),
        scores: entriesToScores(aggregated),
      };
    }
    return {
      cascade: true,
      ...bestGuess(kwResult, semResult, gate, kwWeight, semWeight),
      confScore: 0,
    };
  }

  // Semantic is the primary gate: trusted whenever confident, even if the
  // keyword argmax disagrees.
  if (semConfident && semLabel !== null) {
    return {
      cascade: false,
      label: semLabel,
      score: semTop?.[1].prob ?? 0,
      confScore: semResult.confScore,
      scores: entriesToScores(semResult.entries),
    };
  }

  // Keyword is advisory: trusted alone only when semantic has no signal or
  // its argmax agrees.
  if (kwConfident && kwLabel !== null && (semLabel === null || kwLabel === semLabel)) {
    return {
      cascade: false,
      label: kwLabel,
      score: kwTop?.[1].prob ?? 0,
      confScore: kwResult.confScore,
      scores: entriesToScores(kwResult.entries),
    };
  }

  return {
    cascade: true,
    ...bestGuess(kwResult, semResult, gate, kwWeight, semWeight),
    confScore: 0,
  };
}

/** Top label of a classifier's probability distribution. */
function topEntry(
  entries: Map<string, ClassificationEntry>,
): [string, ClassificationEntry] | undefined {
  const sorted = [...entries.entries()].sort((a, b) => b[1].prob - a[1].prob);
  return sorted[0];
}

/** Blended best-guess (used for graceful degradation when the LLM fails). */
function bestGuess(
  kwResult: ClassificationResult,
  semResult: ClassificationResult,
  gate: Gate,
  kwWeight: number,
  semWeight: number,
): { label: string | null; score: number; scores: Record<string, number> } {
  const aggregated = aggregatePrecascade(kwResult, semResult, gate, kwWeight, semWeight);
  const sorted = [...aggregated.entries()].sort((a, b) => b[1].prob - a[1].prob);
  const top = sorted[0];
  if (!top) return { label: null, score: 0, scores: {} };
  return { label: top[0], score: top[1].prob, scores: entriesToScores(aggregated) };
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

  // Linear blend only — no keyword gate boost.lready weights
  // config (1.2) vs promoted (1.0) keywords internally.
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
