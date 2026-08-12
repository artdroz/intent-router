import type { ClassifierMode, ClassificationResult, ClassificationEntry } from "./types.js";

/** Normalize raw scores → [0, 1] and build ClassificationResult. */
export function buildResult(
  classifier: ClassifierMode,
  scores: Map<string, number>,
  evidence: Map<string, string[]>,
): ClassificationResult {
  const total = [...scores.values()].reduce((a, b) => a + b, 0);
  const entries = new Map<string, ClassificationEntry>();

  for (const [label, score] of scores) {
    entries.set(label, {
      prob: total > 0 ? score / total : 0,
      evidence: evidence.get(label) ?? [],
    });
  }

  return { classifier, entries };
}
