import { describe, expect, it } from "vitest";
import { expandCorpusRows } from "./routing.js";

describe("expandCorpusRows", () => {
  it("maps user feedback 1:1 to the predicted class", () => {
    const rows = [
      {
        predictedClassId: 7,
        correctClassId: null,
        source: "user",
        keywords: ["deploy"],
        positive: 1,
      },
    ];

    expect(expandCorpusRows(rows)).toEqual([{ classId: 7, keywords: ["deploy"], positive: 1 }]);
  });

  it("expands a judge label into gold-positive and predicted-negative docs when they differ", () => {
    const rows = [
      {
        predictedClassId: 7,
        correctClassId: 9,
        source: "judge",
        keywords: ["rollback"],
        positive: 1,
      },
    ];

    expect(expandCorpusRows(rows)).toEqual([
      { classId: 7, keywords: ["rollback"], positive: 0 },
      { classId: 9, keywords: ["rollback"], positive: 1 },
    ]);
  });

  it("emits only the gold-positive doc when the judge agrees with the prediction", () => {
    const rows = [
      {
        predictedClassId: 9,
        correctClassId: 9,
        source: "judge",
        keywords: ["rollback"],
        positive: 1,
      },
    ];

    expect(expandCorpusRows(rows)).toEqual([{ classId: 9, keywords: ["rollback"], positive: 1 }]);
  });

  it("skips judge rows whose gold class was deleted", () => {
    const rows = [
      {
        predictedClassId: 7,
        correctClassId: null,
        source: "judge",
        keywords: ["rollback"],
        positive: 1,
      },
    ];

    expect(expandCorpusRows(rows)).toEqual([]);
  });
});
