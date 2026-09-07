import type { FeedbackCorpusRow } from "../store/routing.js";
import { LRN_PRECISION_FLOOR } from "./constants.js";

/** One feedback document for TF-IDF: the extracted keywords and the positive flag. */
export type FeedbackDoc = {
  keywords: string[];
  positive: number;
};

/** Feedback corpus grouped by class id. */
export type ClassDocs = Map<number, FeedbackDoc[]>;

/** Group flat feedback corpus rows into a per-class map. */
export function groupCorpusByClass(rows: FeedbackCorpusRow[]): ClassDocs {
  const byClass = new Map<number, FeedbackDoc[]>();

  for (const row of rows) {
    const list = byClass.get(row.classId) ?? [];
    list.push({ keywords: row.keywords ?? [], positive: row.positive });
    byClass.set(row.classId, list);
  }

  return byClass;
}

/**
 * DF(k): how many distinct classes contain keyword `k`.
 * Only used when there are ≥2 classes, so it always has enough context.
 */
export function computeDocFrequencies(byClass: ClassDocs): Map<string, number> {
  const docFreq = new Map<string, number>();

  for (const [, docs] of byClass) {
    const seen = new Set<string>();
    for (const doc of docs) {
      for (const kw of doc.keywords) seen.add(kw);
    }
    for (const kw of seen) {
      docFreq.set(kw, (docFreq.get(kw) ?? 0) + 1);
    }
  }

  return docFreq;
}

/**
 * Score a single class's keywords and return the promoted (top-N) list.
 *
 * Score(k, c) = TF_pos(k, c) * IDF(k)
 *   - TF_pos(k, c) = positiveDocsContaining(k, c) / totalDocs(c)
 *   - IDF(k)       = log(numClasses / classesContaining(k))
 *
 * Negative feedback acts as a precision gate (a hard form of "minus scores"):
 * a keyword is promoted only if it has at least {@link LRN_MIN_SUPPORT} positive
 * occurrences AND its precision `pos / (pos + neg)` reaches
 * {@link LRN_PRECISION_FLOOR}. A 5-pos/5-neg keyword (coin flip) is excluded,
 * and a 0-pos keyword (wrongly attributed to this class) can never be promoted.
 */
export function scoreClassKeywords(
  docs: FeedbackDoc[],
  docFreq: Map<string, number>,
  numClasses: number,
  scoreThreshold: number,
  maxPerClass: number,
): string[] {
  const totalDocs = docs.length;
  if (totalDocs === 0) return [];

  const keywords = new Set<string>();
  for (const doc of docs) {
    for (const kw of doc.keywords) keywords.add(kw);
  }

  const tfIdf = new Map<string, number>();
  for (const kw of keywords) {
    const posCount = docs.filter((d) => d.keywords.includes(kw) && d.positive === 1).length;
    const negCount = docs.filter((d) => d.keywords.includes(kw) && d.positive === 0).length;
    // Skip if no enough positive evidence
    if (posCount < 1) continue;

    const precision = posCount / (posCount + negCount);
    if (precision < LRN_PRECISION_FLOOR) continue;

    const tf = posCount / totalDocs;
    const idf = Math.log(numClasses / (docFreq.get(kw) ?? 1));
    tfIdf.set(kw, tf * idf);
  }

  return [...tfIdf.entries()]
    .filter(([, score]) => score > scoreThreshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxPerClass)
    .map(([kw]) => kw);
}
