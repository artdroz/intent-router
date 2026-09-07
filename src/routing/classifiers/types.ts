import type { Gate } from "../../gates/types.js";

/** The three classifier implementations that make up the cascade. */
export type ClassifierMode = "semantic" | "llm" | "keyword";

/** Shared interface implemented by every classifier. */
export interface Classifier {
  readonly name: ClassifierMode;
  classify(prompt: string, gate: Gate, tenantId: string): Promise<ClassificationResult>;
}

export type ClassificationResult = {
  classifier: ClassifierMode;
  entries: Map<string, ClassificationEntry>;
};

export type ClassificationEntry = {
  /** Probability in [0, 1], normalized across classes. */
  prob: number;
  /** Utterances, keywords, or reasoning text behind the score. */
  evidence: string[];
};
