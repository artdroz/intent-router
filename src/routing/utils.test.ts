import { describe, it, expect } from "vitest";
import {
  buildResult,
  computeMargin,
  computeEntropy,
  computeRelativeMargin,
  pickBestLabel,
  sanitizeForProxy,
} from "./utils.js";
import type { ClassificationEntry } from "./classifiers/types.js";

const entry = (prob: number, evidence: string[] = []): ClassificationEntry => ({ prob, evidence });

describe("buildResult", () => {
  it("normalizes scores to sum to 1", () => {
    const scores = new Map([
      ["a", 1],
      ["b", 1],
      ["c", 2],
    ]);
    const entries = buildResult(scores, new Map());

    expect(entries.get("a")!.prob).toBeCloseTo(0.25);
    expect(entries.get("b")!.prob).toBeCloseTo(0.25);
    expect(entries.get("c")!.prob).toBeCloseTo(0.5);
  });

  it("returns 0 probability for all classes when total is 0", () => {
    const scores = new Map([
      ["a", 0],
      ["b", 0],
    ]);
    const entries = buildResult(scores, new Map());

    expect(entries.get("a")!.prob).toBe(0);
    expect(entries.get("b")!.prob).toBe(0);
  });

  it("attaches evidence per class", () => {
    const scores = new Map([["a", 1]]);
    const evidence = new Map([["a", ["match1", "match2"]]]);
    const entries = buildResult(scores, evidence);

    expect(entries.get("a")!.evidence).toEqual(["match1", "match2"]);
  });
});

describe("computeMargin", () => {
  it("returns the difference between top-1 and top-2", () => {
    const sorted: [string, ClassificationEntry][] = [
      ["a", entry(0.6)],
      ["b", entry(0.3)],
      ["c", entry(0.1)],
    ];
    expect(computeMargin(sorted)).toBeCloseTo(0.3);
  });
});

describe("computeEntropy", () => {
  it("is 0 for a fully peaked distribution", () => {
    const entries: [string, ClassificationEntry][] = [
      ["a", entry(1.0)],
      ["b", entry(0.0)],
    ];
    expect(computeEntropy(entries)).toBeCloseTo(0);
  });

  it("is higher for a uniform distribution than a peaked one", () => {
    const uniform: [string, ClassificationEntry][] = [
      ["a", entry(0.5)],
      ["b", entry(0.5)],
    ];
    const peaked: [string, ClassificationEntry][] = [
      ["a", entry(0.9)],
      ["b", entry(0.1)],
    ];
    expect(computeEntropy(uniform)).toBeGreaterThan(computeEntropy(peaked));
  });

  it("ignores zero-probability classes", () => {
    const entries: [string, ClassificationEntry][] = [
      ["a", entry(1.0)],
      ["b", entry(0.0)],
    ];
    expect(computeEntropy(entries)).toBeCloseTo(0);
  });
});

describe("pickBestLabel", () => {
  it("picks the highest-probability label", () => {
    const entries = new Map([
      ["a", entry(0.1)],
      ["b", entry(0.7)],
      ["c", entry(0.2)],
    ]);
    expect(pickBestLabel(entries)).toEqual({ label: "b", score: 0.7 });
  });

  it("returns a null label for an empty map", () => {
    expect(pickBestLabel(new Map())).toEqual({ label: null, score: 0 });
  });

  it("returns a null label when every probability is zero", () => {
    const entries = new Map([
      ["a", entry(0)],
      ["b", entry(0)],
    ]);
    expect(pickBestLabel(entries)).toEqual({ label: null, score: 0 });
  });
});

describe("computeRelativeMargin", () => {
  it("returns the relative gap between the top two", () => {
    const sorted: [string, ClassificationEntry][] = [
      ["a", entry(0.6)],
      ["b", entry(0.3)],
    ];
    expect(computeRelativeMargin(sorted)).toBeCloseTo(0.5);
  });

  it("returns 1.0 for a single-entry distribution", () => {
    const sorted: [string, ClassificationEntry][] = [["a", entry(0.9)]];
    expect(computeRelativeMargin(sorted)).toBe(1.0);
  });

  it("returns 1.0 for an empty distribution instead of crashing", () => {
    // Reached in production when a classifier has no configured signal.
    expect(computeRelativeMargin([])).toBe(1.0);
  });
});

describe("sanitizeForProxy", () => {
  it("neutralizes path-traversal separators", () => {
    expect(sanitizeForProxy("a/../b/file.py")).toBe("a/.. /b/file.py");
    expect(sanitizeForProxy("a\\..\\b")).toBe("a\\.. \\b");
  });

  it("rewrites private and loopback IPv4 addresses", () => {
    expect(sanitizeForProxy("10.0.0.1")).toBe("10_0_0_1");
    expect(sanitizeForProxy("127.0.0.1")).toBe("127_0_0_1");
    expect(sanitizeForProxy("169.254.1.1")).toBe("169_254_1_1");
    expect(sanitizeForProxy("192.168.1.10")).toBe("192_168_1_10");
    expect(sanitizeForProxy("172.16.0.1")).toBe("172_16_0_1");
    expect(sanitizeForProxy("172.31.255.255")).toBe("172_31_255_255");
  });

  it("leaves public IPv4 addresses untouched", () => {
    expect(sanitizeForProxy("8.8.8.8")).toBe("8.8.8.8");
    expect(sanitizeForProxy("172.15.0.1")).toBe("172.15.0.1");
    expect(sanitizeForProxy("172.32.0.1")).toBe("172.32.0.1");
  });

  it("rewrites 0.0.0.0 and localhost case-insensitively", () => {
    expect(sanitizeForProxy("0.0.0.0")).toBe("0_0_0_0");
    expect(sanitizeForProxy("localhost")).toBe("local-host");
    expect(sanitizeForProxy("LocalHost")).toBe("local-host");
  });
});
