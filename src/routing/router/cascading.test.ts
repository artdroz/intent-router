import { describe, it, expect } from "vitest";
import { scoreClass, entriesToScores, shouldCascade, aggregatePrecascade } from "./cascading.js";
import type { ClassificationEntry, ClassificationResult } from "../classifiers/types.js";
import type { Gate } from "../../gates/types.js";

const entry = (prob: number, evidence: string[] = []): ClassificationEntry => ({ prob, evidence });

describe("scoreClass", () => {
  it("applies no boost when the keyword score is zero", () => {
    const result = scoreClass(entry(0.0), entry(0.4), 0.3, 0.7);

    // gateMultiplier = 1 + 0.5 * 0 = 1.0 → (0*0.3 + 0.4*0.7) * 1.0
    expect(result.prob).toBeCloseTo(0.28);
  });

  it("applies the full boost when the keyword score is one", () => {
    const result = scoreClass(entry(1.0), entry(0.0), 0.3, 0.7);

    // gateMultiplier = 1 + 0.5 * 1 = 1.5 → (1*0.3 + 0) * 1.5
    expect(result.prob).toBeCloseTo(0.45);
  });

  it("scales the boost by keyword strength", () => {
    const result = scoreClass(entry(0.6), entry(0.4), 0.3, 0.7);

    // gateMultiplier = 1 + 0.5 * 0.6 = 1.3 → (0.6*0.3 + 0.4*0.7) * 1.3
    expect(result.prob).toBeCloseTo((0.18 + 0.28) * 1.3);
  });

  it("returns zero when both entries are undefined", () => {
    const result = scoreClass(undefined, undefined, 0.3, 0.7);

    expect(result.prob).toBe(0);
    expect(result.evidence).toEqual([]);
  });

  it("merges evidence from both classifiers", () => {
    const result = scoreClass(entry(0.5, ["kw-ev"]), entry(0.5, ["sem-ev"]), 0.5, 0.5);

    expect(result.evidence).toEqual(["kw-ev", "sem-ev"]);
  });
});

describe("entriesToScores", () => {
  it("flattens a label→entry map into a score record", () => {
    const entries = new Map([
      ["a", entry(0.6)],
      ["b", entry(0.4)],
    ]);

    expect(entriesToScores(entries)).toEqual({ a: 0.6, b: 0.4 });
  });

  it("returns an empty object for an empty map", () => {
    expect(entriesToScores(new Map())).toEqual({});
  });
});

describe("shouldCascade", () => {
  it("cascades when the margin is below the threshold", () => {
    expect(shouldCascade(0.1, 0.5, 0.15, 1.2)).toBe(true);
  });

  it("cascades when entropy is above the threshold", () => {
    expect(shouldCascade(0.3, 1.5, 0.15, 1.2)).toBe(true);
  });

  it("does not cascade when both margin and entropy are within bounds", () => {
    expect(shouldCascade(0.3, 0.5, 0.15, 1.2)).toBe(false);
  });

  it("does not cascade at exact thresholds (boundary inclusive)", () => {
    expect(shouldCascade(0.15, 1.2, 0.15, 1.2)).toBe(false);
  });
});

describe("aggregate", () => {
  function makeGate(classes: string[]): Gate {
    return {
      id: 1,
      name: "test",
      description: null,
      config: { learningEnabled: true },
      classes: classes.map((label) => ({
        label,
        utterances: ["x"],
        keywords: [],
        promotedKeywords: [],
      })),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  function result(entries: Map<string, ClassificationEntry>): ClassificationResult {
    return { classifier: "keyword", entries };
  }

  it("aggregates across all gate classes, including classes with no scores", () => {
    const kw = result(new Map([["a", entry(0.8)]]));
    const sem = result(new Map([["b", entry(0.9)]]));
    const gate = makeGate(["a", "b", "c"]);

    const aggregated = aggregatePrecascade(kw, sem, gate, 0.3, 0.7);

    // All three classes must appear, even "c" which had no signal
    expect(aggregated.has("a")).toBe(true);
    expect(aggregated.has("b")).toBe(true);
    expect(aggregated.has("c")).toBe(true);
  });

  it("normalizes the aggregated scores to sum to 1", () => {
    const kw = result(new Map([["a", entry(1.0)]]));
    const sem = result(new Map([["a", entry(1.0)]]));
    const gate = makeGate(["a", "b"]);

    const aggregated = aggregatePrecascade(kw, sem, gate, 0.5, 0.5);

    const total = [...aggregated.values()].reduce((sum, e) => sum + e.prob, 0);
    expect(total).toBeCloseTo(1);
  });
});
