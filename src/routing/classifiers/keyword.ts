import type { Classifier, ClassificationResult } from "./types.js";
import type { Gate } from "../../gates/types.js";
import { KW_CONFIG_WEIGHT, KW_FEEDBACK_WEIGHT } from "../config.js";
import { buildResult } from "./utils.js";

export type KeywordOptions = {
  configWeight?: number;
  feedbackWeight?: number;
};

export class KeywordClassifier implements Classifier {
  readonly name = "keyword" as const;

  private configWeight: number;
  private feedbackWeight: number;

  constructor(opts?: KeywordOptions) {
    this.configWeight = opts?.configWeight ?? KW_CONFIG_WEIGHT;
    this.feedbackWeight = opts?.feedbackWeight ?? KW_FEEDBACK_WEIGHT;
  }

  async classify(prompt: string, gate: Gate): Promise<ClassificationResult> {
    const tokens = tokenize(prompt);
    const scores = new Map<string, number>();
    const evidence = new Map<string, string[]>();

    for (const c of gate.classes) {
      const configMatched = matchedKeywords(tokens, c.keywords);
      const promotedMatched = matchedKeywords(tokens, c.promotedKeywords);
      const configTotal = c.keywords.length;
      const feedbackTotal = c.promotedKeywords.length;

      const weightedHits = configMatched.length * this.configWeight + promotedMatched.length * this.feedbackWeight;
      const weightedTotal = configTotal * this.configWeight + feedbackTotal * this.feedbackWeight;
      const score = weightedTotal > 0 ? weightedHits / weightedTotal : 0;

      scores.set(c.label, score);
      evidence.set(c.label, [...configMatched, ...promotedMatched]);
    }

    return buildResult("keyword", scores, evidence);
  }
}

export function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
}

function matchedKeywords(tokens: Set<string>, keywords: string[]): string[] {
  return keywords.filter((kw) => tokens.has(kw.toLowerCase()));
}
