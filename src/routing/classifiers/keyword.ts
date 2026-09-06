import type { Classifier, ClassificationResult } from "./types.js";
import type { Gate } from "../../gates/types.js";
import { KW_CONFIG_WEIGHT, KW_FEEDBACK_WEIGHT, STOPWORDS } from "../config.js";
import { buildResult } from "../utils.js";
import { getPromotedKeywords } from "../../store/routing.js";

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

  async classify(prompt: string, gate: Gate, tenantId: string): Promise<ClassificationResult> {
    const tokens = tokenize(prompt);
    const scores = new Map<string, number>();
    const evidence = new Map<string, string[]>();
    // Read side only: a learning-disabled gate ignores promoted keywords.
    const learningEnabled = gate.config?.learningEnabled !== false;

    for (const c of gate.classes) {
      const configMatched = matchedKeywords(tokens, c.keywords);
      const promotedKeywords = learningEnabled ? await getPromotedKeywords(c.id, tenantId) : [];
      const promotedMatched = matchedKeywords(tokens, promotedKeywords);
      const configTotal = c.keywords.length;
      const feedbackTotal = promotedKeywords.length;

      const weightedHits =
        configMatched.length * this.configWeight + promotedMatched.length * this.feedbackWeight;
      const weightedTotal = configTotal * this.configWeight + feedbackTotal * this.feedbackWeight;
      const score = weightedTotal > 0 ? weightedHits / weightedTotal : 0;

      scores.set(c.label, score);
      evidence.set(c.label, [...configMatched, ...promotedMatched]);
    }

    return { classifier: "keyword", entries: buildResult(scores, evidence) };
  }
}

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0 && !STOPWORDS.has(t)),
  );
}

function matchedKeywords(tokens: Set<string>, keywords: string[]): string[] {
  return keywords.filter((kw) => tokens.has(kw.toLowerCase()));
}
