import type { Gate } from "../../gates/types.js";

export type ClassifierMode = "semantic" | "llm" | "keyword";

export interface Classifier {
  readonly name: ClassifierMode;
  classify(prompt: string, gate: Gate): Promise<ClassificationResult>;
}

export type ClassificationResult = {
  classifier: ClassifierMode;
  entries: Map<string, ClassificationEntry>;
};

export type ClassificationEntry = {
  prob: number; // [0, 1] — proportional probability normalized across classes
  evidence: string[]; // utterances, keywords, or reasoning text
};
