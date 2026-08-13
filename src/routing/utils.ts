import type { ClassificationEntry } from "./classifiers/types.js";

/** Normalize raw scores → [0, 1] and build ClassificationResult. */
export function buildResult(
  scores: Map<string, number>,
  evidence: Map<string, string[]>,
): Map<string, ClassificationEntry> {
  const total = [...scores.values()].reduce((a, b) => a + b, 0);
  const entries = new Map<string, ClassificationEntry>();

  for (const [cls, score] of scores) {
    entries.set(cls, {
      prob: total > 0 ? score / total : 0,
      evidence: evidence.get(cls) ?? [],
    });
  }

  return entries;
}

/** Difference in probability between the top two candidates. */
export function computeMargin(sorted: [string, ClassificationEntry][]): number {
  const top1 = sorted[0];
  const top2 = sorted[1];
  return top2 ? top1[1].prob - top2[1].prob : 1.0;
}

/** Shannon entropy of the probability distribution. */
export function computeEntropy(entries: Map<string, ClassificationEntry>): number {
  let entropy = 0;
  for (const [, entry] of entries) {
    if (entry.prob > 0) entropy -= entry.prob * Math.log(entry.prob);
  }
  return entropy;
}

/** Pick the highest-probability label, or null when there is no confident winner. */
export function pickBestLabel(entries: Map<string, ClassificationEntry>): {
  label: string | null;
  score: number;
} {
  let bestLabel: string | null = null;
  let bestScore = 0;

  for (const [label, entry] of entries) {
    if (entry.prob > bestScore) {
      bestScore = entry.prob;
      bestLabel = label;
    }
  }

  return { label: bestLabel, score: bestScore };
}
