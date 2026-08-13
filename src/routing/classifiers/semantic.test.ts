import { describe, it, expect } from "vitest";
import { aggregateSemantic } from "./semantic.js";
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
      row({ label: "b", source: "feedback", distance: 0.1 }),
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
    const rows = [
      row({ label: "a", distance: 0.1 }),
      row({ label: "a", distance: 0.2 }),
    ];

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
});
