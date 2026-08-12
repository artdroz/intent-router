import type { Router, RouteResult } from "./types.js";
import type { Gate } from "../../gates/types.js";
import type { ClassificationResult, ClassificationEntry } from "../classifiers/types.js";
import { KeywordClassifier } from "../classifiers/keyword.js";
import { SemanticClassifier } from "../classifiers/semantic.js";
import { LlmClassifier } from "../classifiers/llm.js";
import { CAS_ENTROPY_THRESHOLD, CAS_KEYWORD_GATE_BOOST, CAS_KW_WEIGHT, CAS_MARGIN_THRESHOLD, CAS_SEM_WEIGHT} from "../config.js";

export type CascadeOptions = {
  kwWeight?: number;
  semWeight?: number;
  marginThreshold?: number;
  entropyThreshold?: number;
};

export class CascadingRouter implements Router {
  readonly name = "cascade";

  constructor(
    private keyword: KeywordClassifier,
    private semantic: SemanticClassifier,
    private llm: LlmClassifier,
    private options: CascadeOptions = {},
  ) {}

  async route(prompt: string, gate: Gate): Promise<RouteResult> {
    // 1. Run keyword + semantic in parallel
    const [kwResult, semResult] = await Promise.all([
      this.keyword.classify(prompt, gate),
      this.semantic.classify(prompt, gate),
    ]);

    // 2. Aggregate weighted scores
    const aggregated = this.aggregate(kwResult, semResult, gate);

    const sorted = [...aggregated.entries()].sort(
      (a, b) => b[1].prob - a[1].prob,
    );

    const top1 = sorted[0];
    const top2 = sorted[1];
    const margin = top2 ? top1[1].prob - top2[1].prob : 1.0;

    // 3. Entropy check
    let entropy = 0;
    for (const [, entry] of aggregated) {
      if (entry.prob > 0) entropy -= entry.prob * Math.log(entry.prob);
    }

    const marginThreshold = this.options.marginThreshold ?? CAS_MARGIN_THRESHOLD;
    const entropyThreshold = this.options.entropyThreshold ?? CAS_ENTROPY_THRESHOLD;
    const wouldCascade = margin < marginThreshold || entropy > entropyThreshold;

    // 4. Build scores map
    const scores: Record<string, number> = {};
    for (const [label, entry] of aggregated) {
      scores[label] = entry.prob;
    }

    if (!wouldCascade) {
      return { label: top1[0], score: top1[1].prob, stage: "pre-cascade", scores };
    }

    // 5. Low confidence — fall back to LLM
    const llmResult = await this.llm.classify(prompt, gate);
    const llmScores: Record<string, number> = {};
    let bestLabel = "";
    let bestScore = 0;

    for (const [label, entry] of llmResult.entries) {
      llmScores[label] = entry.prob;
      if (entry.prob > bestScore) {
        bestScore = entry.prob;
        bestLabel = label;
      }
    }

    return { label: bestLabel, score: bestScore, stage: "llm", scores: llmScores };
  }

  /** Weighted sum of keyword + semantic scores, with keyword-gating boost. */
  private aggregate(
    kw: ClassificationResult,
    sem: ClassificationResult,
    gate: Gate,
  ): Map<string, ClassificationEntry> {
    const kwWeight = this.options.kwWeight ?? CAS_KW_WEIGHT;
    const semWeight = this.options.semWeight ?? CAS_SEM_WEIGHT;

    const scores = new Map<string, number>();
    const evidence = new Map<string, string[]>();

    for (const label of gate.classes.map((c) => c.label)) {
      const kwEntry = kw.entries.get(label);
      const semEntry = sem.entries.get(label);

      const kwScore = kwEntry?.prob ?? 0;
      const semScore = semEntry?.prob ?? 0;
      
      // When keyword classifier matched tokens for it, boost the score
      const hasKeywordMatch = (kwEntry?.evidence?.length ?? 0) > 0;
      const gateMultiplier = hasKeywordMatch ? CAS_KEYWORD_GATE_BOOST : 1.0;

      const weighted = (kwScore * kwWeight + semScore * semWeight) * gateMultiplier;
      scores.set(label, weighted);
      evidence.set(label, [
        ...(kwEntry?.evidence ?? []),
        ...(semEntry?.evidence ?? []),
      ]);
    }

    const total = [...scores.values()].reduce((a, b) => a + b, 0);
    const result = new Map<string, ClassificationEntry>();

    for (const [label, score] of scores) {
      result.set(label, {
        prob: total > 0 ? score / total : 0,
        evidence: evidence.get(label) ?? [],
      });
    }

    return result;
  }
}
