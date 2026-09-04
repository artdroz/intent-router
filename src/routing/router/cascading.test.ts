import { describe, it, expect, vi } from "vitest";
import {
  scoreClass,
  entriesToScores,
  shouldCascade,
  aggregatePrecascade,
  CascadingRouter,
  hasConfiguredKeywords,
  hasConfiguredUtterances,
} from "./cascading.js";
import type { ClassificationEntry, ClassificationResult } from "../classifiers/types.js";
import type { Gate } from "../../gates/types.js";

const entry = (prob: number, evidence: string[] = []): ClassificationEntry => ({ prob, evidence });

describe("scoreClass", () => {
  it("combines keyword and semantic scores with a linear blend", () => {
    const result = scoreClass(entry(0.0), entry(0.4), 0.3, 0.7);

    // (0*0.3 + 0.4*0.7)
    expect(result.prob).toBeCloseTo(0.28);
  });

  it("ignores the semantic score when it has no signal", () => {
    const result = scoreClass(entry(1.0), entry(0.0), 0.3, 0.7);

    // (1*0.3 + 0*0.7)
    expect(result.prob).toBeCloseTo(0.3);
  });

  it("weights keyword and semantic scores independently", () => {
    const result = scoreClass(entry(0.6), entry(0.4), 0.3, 0.7);

    // (0.6*0.3 + 0.4*0.7)
    expect(result.prob).toBeCloseTo(0.18 + 0.28);
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
  const kw = (label: string, prob: number): ClassificationResult => ({
    classifier: "keyword",
    entries: new Map([[label, entry(prob)]]),
  });
  const sem = (label: string, prob: number): ClassificationResult => ({
    classifier: "semantic",
    entries: new Map([[label, entry(prob)]]),
  });

  it("cascades when the margin is below the threshold", () => {
    const sorted: [string, ClassificationEntry][] = [
      ["a", entry(0.5)],
      ["b", entry(0.5)],
    ];
    expect(shouldCascade(sorted, kw("a", 0.5), sem("a", 0.5), 0.6, 1.2)).toBe(true);
  });

  it("cascades when entropy is above the threshold", () => {
    const sorted: [string, ClassificationEntry][] = [
      ["a", entry(0.5)],
      ["b", entry(0.3)],
      ["c", entry(0.2)],
    ];
    expect(shouldCascade(sorted, kw("a", 0.5), sem("a", 0.5), 0.15, 0.8)).toBe(true);
  });

  it("does not cascade for a confident distribution with conflicting classifiers", () => {
    const sorted: [string, ClassificationEntry][] = [
      ["a", entry(0.9)],
      ["b", entry(0.1)],
    ];
    expect(shouldCascade(sorted, kw("a", 0.9), sem("b", 0.9), 0.15, 1.2)).toBe(false);
  });

  it("cascades for a confident distribution with agreeing classifiers", () => {
    const sorted: [string, ClassificationEntry][] = [
      ["a", entry(0.9)],
      ["b", entry(0.1)],
    ];
    expect(shouldCascade(sorted, kw("a", 0.9), sem("a", 0.9), 0.15, 1.2)).toBe(true);
  });
});

describe("aggregate", () => {
  function makeGate(classes: string[]): Gate {
    return {
      id: 1,
      tenantId: "tenant-1",
      name: "test",
      description: null,
      config: { learningEnabled: true },
      classes: classes.map((label, i) => ({
        id: i + 1,
        label,
        utterances: ["x"],
        keywords: [],
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

describe("safety-net helpers", () => {
  function gate(
    classes: Array<{ label: string; keywords?: string[]; utterances?: string[] }>,
  ): Gate {
    return {
      id: 1,
      tenantId: "tenant-1",
      name: "test",
      description: null,
      config: { learningEnabled: true },
      classes: classes.map((c, i) => ({
        id: i + 1,
        label: c.label,
        utterances: c.utterances ?? [],
        keywords: c.keywords ?? [],
      })),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it("detects configured keywords", () => {
    expect(hasConfiguredKeywords(gate([{ label: "a", keywords: ["x"] }]))).toBe(true);
    expect(hasConfiguredKeywords(gate([{ label: "a" }]))).toBe(false);
  });

  it("detects configured utterances", () => {
    expect(hasConfiguredUtterances(gate([{ label: "a", utterances: ["x"] }]))).toBe(true);
    expect(hasConfiguredUtterances(gate([{ label: "a" }]))).toBe(false);
  });
});

describe("CascadingRouter safety nets", () => {
  function gate(
    classes: Array<{ label: string; keywords?: string[]; utterances?: string[] }>,
  ): Gate {
    return {
      id: 1,
      tenantId: "tenant-1",
      name: "test",
      description: null,
      config: { learningEnabled: true },
      classes: classes.map((c, i) => ({
        id: i + 1,
        label: c.label,
        utterances: c.utterances ?? [],
        keywords: c.keywords ?? [],
      })),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  const kwResult: ClassificationResult = {
    classifier: "keyword",
    entries: new Map([
      ["a", entry(1.0)],
      ["b", entry(0.0)],
    ]),
  };
  const semResult: ClassificationResult = {
    classifier: "semantic",
    entries: new Map([
      ["a", entry(0.2)],
      ["b", entry(0.8)],
    ]),
  };
  const llmResult: ClassificationResult = {
    classifier: "llm",
    entries: new Map([
      ["a", entry(0.5)],
      ["b", entry(0.5)],
    ]),
  };
  const llmOkResult: ClassificationResult = {
    classifier: "llm",
    entries: new Map([
      ["a", entry(0.9)],
      ["b", entry(0.1)],
    ]),
  };
  const nullLlmResult: ClassificationResult = {
    classifier: "llm",
    entries: new Map(),
  };
  const ambiguousKwResult: ClassificationResult = {
    classifier: "keyword",
    entries: new Map([
      ["a", entry(0.5)],
      ["b", entry(0.5)],
    ]),
  };

  it("uses semantic only when no keywords are configured", async () => {
    const keywordSpy = vi.fn<() => Promise<ClassificationResult>>().mockResolvedValue(kwResult);
    const semanticSpy = vi.fn<() => Promise<ClassificationResult>>().mockResolvedValue(semResult);

    const router = new CascadingRouter(
      { name: "keyword", classify: keywordSpy },
      { name: "semantic", classify: semanticSpy },
      { name: "llm", classify: () => Promise.resolve(llmResult) },
    );

    const result = await router.route(
      "hello",
      gate([
        { label: "a", utterances: ["x"] },
        { label: "b", utterances: ["y"] },
      ]),
      "tenant-1",
    );

    expect(keywordSpy).not.toHaveBeenCalled();
    expect(semanticSpy).toHaveBeenCalledOnce();
    expect(result.stage).toBe("pre-cascade");
    expect(result.label).toBe("b");
  });

  it("uses keyword only when no utterances are configured", async () => {
    const keywordSpy = vi.fn<() => Promise<ClassificationResult>>().mockResolvedValue(kwResult);
    const semanticSpy = vi.fn<() => Promise<ClassificationResult>>().mockResolvedValue(semResult);

    const router = new CascadingRouter(
      { name: "keyword", classify: keywordSpy },
      { name: "semantic", classify: semanticSpy },
      { name: "llm", classify: () => Promise.resolve(llmResult) },
    );

    const result = await router.route(
      "hello",
      gate([
        { label: "a", keywords: ["x"] },
        { label: "b", keywords: ["y"] },
      ]),
      "tenant-1",
    );

    expect(keywordSpy).toHaveBeenCalledOnce();
    expect(semanticSpy).not.toHaveBeenCalled();
    expect(result.stage).toBe("pre-cascade");
    expect(result.label).toBe("a");
  });

  it("falls back to LLM when neither keywords nor utterances are configured", async () => {
    const keywordSpy = vi.fn<() => Promise<ClassificationResult>>().mockResolvedValue(kwResult);
    const semanticSpy = vi.fn<() => Promise<ClassificationResult>>().mockResolvedValue(semResult);
    const llmSpy = vi.fn<() => Promise<ClassificationResult>>().mockResolvedValue(llmResult);

    const router = new CascadingRouter(
      { name: "keyword", classify: keywordSpy },
      { name: "semantic", classify: semanticSpy },
      { name: "llm", classify: llmSpy },
    );

    const result = await router.route("hello", gate([{ label: "a" }, { label: "b" }]), "tenant-1");

    expect(keywordSpy).not.toHaveBeenCalled();
    expect(semanticSpy).not.toHaveBeenCalled();
    expect(llmSpy).toHaveBeenCalledOnce();
    expect(result.stage).toBe("llm");
    expect(result.label).toBe("a");
  });

  it("retries the LLM up to three times when it returns no usable label", async () => {
    const keywordSpy = vi.fn<() => Promise<ClassificationResult>>().mockResolvedValue(kwResult);
    const semanticSpy = vi.fn<() => Promise<ClassificationResult>>().mockResolvedValue(semResult);
    const llmSpy = vi
      .fn<() => Promise<ClassificationResult>>()
      .mockResolvedValueOnce(nullLlmResult)
      .mockResolvedValueOnce(nullLlmResult)
      .mockResolvedValueOnce(llmOkResult);

    const router = new CascadingRouter(
      { name: "keyword", classify: keywordSpy },
      { name: "semantic", classify: semanticSpy },
      { name: "llm", classify: llmSpy },
    );

    const result = await router.route("hello", gate([{ label: "a" }, { label: "b" }]), "tenant-1");

    expect(keywordSpy).not.toHaveBeenCalled();
    expect(semanticSpy).not.toHaveBeenCalled();
    expect(llmSpy).toHaveBeenCalledTimes(3);
    expect(result.stage).toBe("llm");
    expect(result.label).toBe("a");
  });

  it("falls back to the most-frequent historical class when everything else fails", async () => {
    const llmSpy = vi.fn<() => Promise<ClassificationResult>>().mockResolvedValue(nullLlmResult);
    const historical = vi.fn<() => Promise<string | null>>().mockResolvedValue("b");

    const router = new CascadingRouter(
      { name: "keyword", classify: () => Promise.resolve(kwResult) },
      { name: "semantic", classify: () => Promise.resolve(semResult) },
      { name: "llm", classify: llmSpy },
      {},
      historical,
    );

    const result = await router.route("hello", gate([{ label: "a" }, { label: "b" }]), "tenant-1");

    expect(llmSpy).toHaveBeenCalledTimes(3);
    expect(historical).toHaveBeenCalledOnce();
    expect(result.stage).toBe("historical");
    expect(result.label).toBe("b");
    expect(result.score).toBe(0);
  });

  it("degrades to pre-cascade without consulting history when the LLM fails", async () => {
    const keywordSpy = vi
      .fn<() => Promise<ClassificationResult>>()
      .mockResolvedValue(ambiguousKwResult);
    const semanticSpy = vi.fn<() => Promise<ClassificationResult>>().mockResolvedValue(semResult);
    const llmSpy = vi.fn<() => Promise<ClassificationResult>>().mockResolvedValue(nullLlmResult);
    const historical = vi.fn<() => Promise<string | null>>().mockResolvedValue("a");

    const router = new CascadingRouter(
      { name: "keyword", classify: keywordSpy },
      { name: "semantic", classify: semanticSpy },
      { name: "llm", classify: llmSpy },
      {},
      historical,
    );

    // Keywords configured on both classes → pre-cascade runs, but the 50/50
    // keyword distribution has margin 0, so it cascades to the LLM.
    const result = await router.route(
      "hello",
      gate([
        { label: "a", keywords: ["x"] },
        { label: "b", keywords: ["y"] },
      ]),
      "tenant-1",
    );

    expect(keywordSpy).toHaveBeenCalledOnce();
    expect(semanticSpy).not.toHaveBeenCalled();
    expect(llmSpy).toHaveBeenCalledTimes(3);
    expect(historical).not.toHaveBeenCalled();
    expect(result.stage).toBe("pre-cascade");
  });
});
