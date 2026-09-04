import type { Classifier, ClassificationResult } from "./types.js";
import type { Gate } from "../../gates/types.js";
import {
  KW_CONF_COUNT_THRESHOLD,
  KW_CONF_MARGIN_THRESHOLD,
  KW_FEEDBACK_BETA,
  STOPWORDS,
} from "../config.js";
import { buildResult, computeConfidence } from "../utils.js";
import { getPromotedKeywords } from "../../store/routing.js";

export type KeywordOptions = {
  countThreshold?: number;
  marginThreshold?: number;
  beta?: number;
};

/** Per-class raw keyword evidence, independent of the sweepable hyperparams. */
export type KeywordClassHits = {
  configHits: number;
  configTotal: number;
  promotedHits: number;
  evidence: string[];
};

export class KeywordClassifier implements Classifier {
  readonly name = "keyword" as const;

  private countThreshold: number;
  private marginThreshold: number;
  private beta: number;

  constructor(opts?: KeywordOptions) {
    this.countThreshold = opts?.countThreshold ?? KW_CONF_COUNT_THRESHOLD;
    this.marginThreshold = opts?.marginThreshold ?? KW_CONF_MARGIN_THRESHOLD;
    this.beta = opts?.beta ?? KW_FEEDBACK_BETA;
  }

  async classify(prompt: string, gate: Gate, tenantId: string): Promise<ClassificationResult> {
    const hits = await collectHits(prompt, gate, tenantId);

    const scores = new Map<string, number>();
    const strengths = new Map<string, number>();
    const evidence = new Map<string, string[]>();

    for (const c of gate.classes) {
      const hit = hits.get(c.label);
      scores.set(c.label, hit ? scoreKeywordClass(hit, this.beta) : 0);
      strengths.set(c.label, hit ? hit.configHits + hit.promotedHits : 0);
      evidence.set(c.label, hit?.evidence ?? []);
    }

    const entries = buildResult(scores, evidence);
    const sorted = [...entries.entries()].sort((a, b) => b[1].prob - a[1].prob);
    const top = sorted[0];

    // Confidence of the predicted (top-by-score) class. The score is the
    // normalized class score, so the argmax is identical for prob and score.
    let confScore = 0;
    if (top) {
      const topLabel = top[0];
      const topScore = scores.get(topLabel) ?? 0;
      const secondScore = secondBestScore(topLabel, scores);
      const strength = strengths.get(topLabel) ?? 0;
      const margin = topScore - secondScore;

      confScore = computeConfidence(strength, this.countThreshold, margin, this.marginThreshold);
    }

    return {
      classifier: "keyword",
      entries,
      confScore,
      isConfident: confScore >= 1,
    };
  }
}

/** Collect per-class keyword hits (config + promoted) for a prompt. */
export async function collectHits(
  prompt: string,
  gate: Gate,
  tenantId: string,
): Promise<Map<string, KeywordClassHits>> {
  const tokens = tokenize(prompt);
  const hits = new Map<string, KeywordClassHits>();

  for (const c of gate.classes) {
    const configHits = hitKeywords(tokens, c.keywords);
    const promotedKeywords = await getPromotedKeywords(c.id, tenantId);
    const promotedHits = hitKeywords(tokens, promotedKeywords);

    hits.set(c.label, {
      configHits: configHits.length,
      configTotal: c.keywords.length,
      promotedHits: promotedHits.length,
      evidence: [...configHits, ...promotedHits],
    });
  }

  return hits;
}

/**
 * Per-class keyword score: config coverage rate plus a bounded bonus per
 * promoted-keyword hit. Shared by the classifier and the threshold tuner.
 */
export function scoreKeywordClass(hit: KeywordClassHits, beta: number): number {
  const configRate = hit.configTotal > 0 ? hit.configHits / hit.configTotal : 0;
  return Math.min(1, configRate + beta * hit.promotedHits);
}

/** Highest score among classes other than `topLabel`. */
function secondBestScore(topLabel: string, scores: Map<string, number>): number {
  let best = 0;
  for (const [label, score] of scores) {
    if (label !== topLabel) best = Math.max(best, score);
  }
  return best;
}

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0 && !STOPWORDS.has(t)),
  );
}

function hitKeywords(tokens: Set<string>, keywords: string[]): string[] {
  return keywords.filter((kw) => tokens.has(kw.toLowerCase()));
}
