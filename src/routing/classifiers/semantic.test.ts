import { describe, it, expect } from "vitest";
import { aggregateSemantic, detectVetoedLabels } from "./semantic.js";
import type { SearchResult } from "../../store/embeddings.js";

function row(partial: Partial<SearchResult> & { label: string }): SearchResult {
  return {
    id: 1,
    classId: 1,
    gateName: "test",
    content: "content",
    source: "config",
    distance: 0.1,
    ...partial,
  };
}

describe("aggregateSemantic", () => {
  it("weights config embeddings more than feedback embeddings", () => {
    const rows = [
      row({ label: "a", source: "config", distance: 0.1 }),
      row({ label: "b", source: "pos_feedback", distance: 0.1 }),
    ];

    // config sim = (1-0.1)*1.2 = 1.08; feedback sim = (1-0.1)*1.0 = 0.9
    const result = aggregateSemantic(rows, 0.7, 1.2, 1.0);

    expect(result.entries.get("a")!.prob).toBeGreaterThan(result.entries.get("b")!.prob);
  });

  it("drops rows whose distance is below the similarity threshold", () => {
    const rows = [
      row({ label: "a", distance: 0.1 }), // similar → kept
      row({ label: "b", distance: 0.9 }), // dissimilar → dropped
    ];

    const result = aggregateSemantic(rows, 0.5, 1.0, 1.0);

    expect(result.entries.has("a")).toBe(true);
    // "b" was dropped entirely, so it's absent from the entries
    expect(result.entries.has("b")).toBe(false);
  });

  it("sums similarities across multiple rows of the same class", () => {
    const rows = [row({ label: "a", distance: 0.1 }), row({ label: "a", distance: 0.2 })];

    const result = aggregateSemantic(rows, 0.7, 1.0, 1.0);

    // Single class, sum normalizes to 1.0
    expect(result.entries.get("a")!.prob).toBe(1);
  });

  it("returns empty entries for an empty result set", () => {
    const result = aggregateSemantic([], 0.7, 1.0, 1.0);

    expect(result.entries.size).toBe(0);
  });

  it("collects matched content as evidence", () => {
    const rows = [
      row({ label: "a", content: "deploy now", distance: 0.1 }),
      row({ label: "a", content: "rollout", distance: 0.2 }),
    ];

    const result = aggregateSemantic(rows, 0.7, 1.0, 1.0);

    expect(result.entries.get("a")!.evidence).toEqual(["deploy now", "rollout"]);
  });

  it("ignores negative guardrails as positive evidence", () => {
    const rows = [
      row({ label: "a", source: "neg_feedback", distance: 0.1 }),
      row({ label: "a", source: "config", distance: 0.1 }),
    ];

    const result = aggregateSemantic(rows, 0.7, 1.0, 1.0);

    // Only the config row contributes; the guardrail is excluded from scoring.
    expect(result.entries.get("a")!.prob).toBe(1);
  });

  it("returns empty entries when all rows are guardrails", () => {
    const rows = [row({ label: "a", source: "neg_feedback", distance: 0.1 })];

    const result = aggregateSemantic(rows, 0.7, 1.0, 1.0);

    expect(result.entries.size).toBe(0);
  });
});

describe("detectVetoedLabels", () => {
  // Defaults under test: vetoThreshold = 0.5, minVotes = 2, margin = 0.
  it("vetoes a label with a quorum of guardrails above the veto threshold", () => {
    const rows = [
      row({ label: "x", source: "neg_feedback", distance: 0.1 }), // sim 0.9
      row({ label: "x", source: "neg_feedback", distance: 0.2 }), // sim 0.8 (2nd vote)
      row({ label: "y", source: "neg_feedback", distance: 0.1 }), // sim 0.9, only 1 vote
    ];

    expect(detectVetoedLabels(rows)).toEqual(new Set(["x"]));
  });

  it("vetoes nothing below the vote quorum", () => {
    const rows = [row({ label: "x", source: "neg_feedback", distance: 0.1 })];

    expect(detectVetoedLabels(rows).size).toBe(0);
  });

  it("vetoes nothing below the veto similarity threshold", () => {
    const rows = [
      row({ label: "x", source: "neg_feedback", distance: 0.6 }), // sim 0.4 < 0.5
      row({ label: "x", source: "neg_feedback", distance: 0.7 }), // sim 0.3 < 0.5
    ];

    expect(detectVetoedLabels(rows).size).toBe(0);
  });

  it("does not veto a label whose positive evidence beats the guardrails", () => {
    const rows = [
      row({ label: "x", source: "neg_feedback", distance: 0.2 }), // sim 0.8
      row({ label: "x", source: "neg_feedback", distance: 0.3 }), // sim 0.7 (2nd vote)
      row({ label: "x", source: "config", distance: 0.1 }), // sim 0.9 > 0.8 → positive wins
    ];

    expect(detectVetoedLabels(rows).size).toBe(0);
  });

  it("vetoes multiple intents independently", () => {
    const rows = [
      row({ label: "x", source: "neg_feedback", distance: 0.1 }),
      row({ label: "x", source: "neg_feedback", distance: 0.2 }),
      row({ label: "y", source: "neg_feedback", distance: 0.1 }),
      row({ label: "y", source: "neg_feedback", distance: 0.2 }),
    ];

    expect(detectVetoedLabels(rows)).toEqual(new Set(["x", "y"]));
  });
});
