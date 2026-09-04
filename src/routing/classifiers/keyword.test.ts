import { describe, it, expect, vi, beforeEach } from "vitest";
import { KeywordClassifier, tokenize } from "./keyword.js";
import type { Gate, GateClass } from "../../gates/types.js";
import { getPromotedKeywords } from "../../store/routing.js";

vi.mock("../../store/routing.js", () => ({
  getPromotedKeywords: vi.fn(),
}));

const getPromotedKeywordsMock = vi.mocked(getPromotedKeywords);

let nextId = 1;

function makeClass(partial: Partial<GateClass> & { label: string }): GateClass {
  return {
    id: nextId++,
    utterances: ["placeholder"],
    keywords: [],
    ...partial,
  };
}

function makeGate(classes: GateClass[]): Gate {
  return {
    id: 1,
    tenantId: "tenant-1",
    name: "test",
    description: null,
    config: { learningEnabled: true },
    classes,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  nextId = 1;
  getPromotedKeywordsMock.mockReset();
  getPromotedKeywordsMock.mockResolvedValue([]);
});

describe("tokenize", () => {
  it("lowercases, splits on whitespace, and drops stopwords", () => {
    expect(tokenize("Deploy TO Staging")).toEqual(new Set(["deploy", "staging"]));
  });

  it("deduplicates repeated words", () => {
    expect(tokenize("deploy deploy DEPLOY")).toEqual(new Set(["deploy"]));
  });

  it("returns an empty set for empty or whitespace-only input", () => {
    expect(tokenize("")).toEqual(new Set());
    expect(tokenize("   \t\n  ")).toEqual(new Set());
  });

  it("handles multiple consecutive spaces and stopwords", () => {
    expect(tokenize("a  b   c")).toEqual(new Set(["b", "c"]));
  });
});

describe("KeywordClassifier", () => {
  it("scores a class with hitting keywords higher", async () => {
    const gate = makeGate([
      makeClass({ label: "deploy", keywords: ["deploy", "rollout"] }),
      makeClass({ label: "debug", keywords: ["debug", "fix"] }),
    ]);

    const result = await new KeywordClassifier().classify("deploy now", gate, "tenant-1");

    expect(result.entries.get("deploy")!.prob).toBe(1);
    expect(result.entries.get("debug")!.prob).toBe(0);
  });

  it("records hit keywords as evidence", async () => {
    const gate = makeGate([
      makeClass({ label: "deploy", keywords: ["deploy", "rollout"] }),
      makeClass({ label: "debug", keywords: ["debug"] }),
    ]);

    const result = await new KeywordClassifier().classify("deploy", gate, "tenant-1");

    expect(result.entries.get("deploy")!.evidence).toEqual(["deploy"]);
    expect(result.entries.get("debug")!.evidence).toEqual([]);
  });

  it("returns zero score for classes with no keyword overlap", async () => {
    const gate = makeGate([
      makeClass({ label: "deploy", keywords: ["deploy"] }),
      makeClass({ label: "debug", keywords: ["debug"] }),
    ]);

    const result = await new KeywordClassifier().classify("completely unrelated", gate, "tenant-1");

    expect(result.entries.get("deploy")!.prob).toBe(0);
    expect(result.entries.get("debug")!.prob).toBe(0);
  });

  it("does not crash on a class with zero keywords", async () => {
    const gate = makeGate([
      makeClass({ label: "empty", keywords: [] }),
      makeClass({ label: "debug", keywords: ["debug"] }),
    ]);

    const result = await new KeywordClassifier().classify("debug", gate, "tenant-1");

    expect(result.entries.get("empty")!.prob).toBe(0);
    expect(result.entries.get("debug")!.prob).toBe(1);
  });

  it("gives promoted keyword hits a score bonus", async () => {
    const deploy = makeClass({ label: "deploy", keywords: [] });
    const debug = makeClass({ label: "debug", keywords: [] });

    getPromotedKeywordsMock.mockImplementation((classId) => {
      if (classId === deploy.id) return Promise.resolve(["ship"]);
      if (classId === debug.id) return Promise.resolve(["fix"]);
      return Promise.resolve([]);
    });

    const gate = makeGate([deploy, debug]);

    const result = await new KeywordClassifier().classify("ship it", gate, "tenant-1");

    expect(result.entries.get("deploy")!.prob).toBe(1);
  });
});
