import { describe, it, expect } from "vitest";
import {
  groupCorpusByClass,
  computeDocFrequencies,
  scoreClassKeywords,
  type ClassDocs,
} from "./tfidf.js";
import type { FeedbackCorpusRow } from "../store/routing.js";

describe("groupCorpusByClass", () => {
  it("groups flat rows by classId", () => {
    const rows: FeedbackCorpusRow[] = [
      { classId: 1, keywords: ["deploy"], positive: 1 },
      { classId: 2, keywords: ["debug"], positive: 0 },
      { classId: 1, keywords: ["rollout"], positive: 1 },
    ];

    const grouped = groupCorpusByClass(rows);

    expect(grouped.get(1)).toHaveLength(2);
    expect(grouped.get(2)).toHaveLength(1);
  });

  it("treats null keywords as empty", () => {
    const rows: FeedbackCorpusRow[] = [{ classId: 1, keywords: null, positive: 1 }];
    const grouped = groupCorpusByClass(rows);

    expect(grouped.get(1)![0].keywords).toEqual([]);
  });
});

describe("computeDocFrequencies", () => {
  it("counts distinct classes per keyword", () => {
    const byClass: ClassDocs = new Map([
      [1, [{ keywords: ["deploy", "error"], positive: 1 }]],
      [2, [{ keywords: ["debug", "error"], positive: 1 }]],
    ]);

    const df = computeDocFrequencies(byClass);

    expect(df.get("error")).toBe(2); // appears in both classes
    expect(df.get("deploy")).toBe(1);
    expect(df.get("debug")).toBe(1);
  });
});

describe("scoreClassKeywords", () => {
  it("promotes keywords unique to a class", () => {
    const byClass: ClassDocs = new Map([
      [1, [{ keywords: ["deploy"], positive: 1 }]],
      [2, [{ keywords: ["debug"], positive: 1 }]],
    ]);
    const df = computeDocFrequencies(byClass);

    const promoted = scoreClassKeywords(byClass.get(1)!, df, 2, 0, 10);

    expect(promoted).toEqual(["deploy"]);
  });

  it("suppresses keywords that appear in every class (idf = 0)", () => {
    const byClass: ClassDocs = new Map([
      [1, [{ keywords: ["error", "deploy"], positive: 1 }]],
      [2, [{ keywords: ["error", "debug"], positive: 1 }]],
    ]);
    const df = computeDocFrequencies(byClass);

    const promoted = scoreClassKeywords(byClass.get(1)!, df, 2, 0.01, 10);

    expect(promoted).not.toContain("error");
    expect(promoted).toContain("deploy");
  });

  it("excludes zero-score keywords even when the threshold is 0", () => {
    const byClass: ClassDocs = new Map([
      [1, [{ keywords: ["error", "deploy"], positive: 1 }]],
      [2, [{ keywords: ["error", "debug"], positive: 1 }]],
    ]);
    const df = computeDocFrequencies(byClass);

    // "error" has idf=0 → score 0 → excluded regardless of threshold
    const promoted = scoreClassKeywords(byClass.get(1)!, df, 2, 0, 10);

    expect(promoted).not.toContain("error");
    expect(promoted).toContain("deploy");
  });

  it("never promotes a keyword with zero positive support", () => {
    const byClass: ClassDocs = new Map([
      [1, [{ keywords: ["deploy"], positive: 0 }]], // negative-only → wrongly attributed
      [2, [{ keywords: ["debug"], positive: 1 }]],
    ]);
    const df = computeDocFrequencies(byClass);

    const promoted = scoreClassKeywords(byClass.get(1)!, df, 2, 0, 10);

    expect(promoted).toEqual([]);
  });

  it("drops keywords whose precision is below the floor (coin-flip)", () => {
    // 1 pos / 1 neg → precision 0.5 < LRN_PRECISION_FLOOR (0.6)
    const byClass: ClassDocs = new Map([
      [
        1,
        [
          { keywords: ["mixed"], positive: 1 },
          { keywords: ["mixed"], positive: 0 },
        ],
      ],
      [2, [{ keywords: ["debug"], positive: 1 }]],
    ]);
    const df = computeDocFrequencies(byClass);

    const promoted = scoreClassKeywords(byClass.get(1)!, df, 2, 0, 10);

    expect(promoted).toEqual([]);
  });

  it("keeps keywords with sufficient positive precision", () => {
    // 2 pos / 1 neg → precision 0.67 ≥ 0.6
    const byClass: ClassDocs = new Map([
      [
        1,
        [
          { keywords: ["good"], positive: 1 },
          { keywords: ["good"], positive: 1 },
          { keywords: ["good"], positive: 0 },
        ],
      ],
      [2, [{ keywords: ["debug"], positive: 1 }]],
    ]);
    const df = computeDocFrequencies(byClass);

    const promoted = scoreClassKeywords(byClass.get(1)!, df, 2, 0, 10);

    expect(promoted).toEqual(["good"]);
  });

  it("returns empty for a class with no documents", () => {
    expect(scoreClassKeywords([], new Map(), 2, 0, 10)).toEqual([]);
  });

  it("caps the result at maxPerClass", () => {
    const byClass: ClassDocs = new Map([
      [1, [{ keywords: ["a", "b", "c", "d", "e"], positive: 1 }]],
      [2, [{ keywords: ["z"], positive: 1 }]],
    ]);
    const df = computeDocFrequencies(byClass);

    const promoted = scoreClassKeywords(byClass.get(1)!, df, 2, 0, 3);

    expect(promoted).toHaveLength(3);
  });

  it("filters keywords below the score threshold", () => {
    // A keyword appearing in all classes has idf=0 → score 0 → filtered at any positive threshold
    const byClass: ClassDocs = new Map([
      [1, [{ keywords: ["common", "unique1"], positive: 1 }]],
      [2, [{ keywords: ["common", "unique2"], positive: 1 }]],
    ]);
    const df = computeDocFrequencies(byClass);

    const promoted = scoreClassKeywords(byClass.get(1)!, df, 2, 0.01, 10);

    expect(promoted).not.toContain("common");
    expect(promoted).toContain("unique1");
  });
});
