import type { FeedbackCorpusRow } from "../store/routing.js";

export type FeedbackDoc = {
  keywords: string[];
  positive: number;
};

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
 * Score(k, c) = TF(k, c) * IDF(k) * signalRatio(k, c)
 *   - TF(k, c)      = docsContaining(k, c) / totalDocs(c)
 *   - IDF(k)        = log(numClasses / classesContaining(k))
 *   - signalRatio   = (posCount + 1) / (posCount + negCount + 1)  (Laplace-smoothed)
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
    const tf = docs.filter((d) => d.keywords.includes(kw)).length / totalDocs;
    const idf = Math.log(numClasses / (docFreq.get(kw) ?? 1));
    const signalRatio = (posCount + 1) / (posCount + negCount + 1);
    tfIdf.set(kw, tf * idf * signalRatio);
  }

  return [...tfIdf.entries()]
    .filter(([, score]) => score > scoreThreshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxPerClass)
    .map(([kw]) => kw);
}
