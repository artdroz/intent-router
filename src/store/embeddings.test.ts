import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDb } from "./db.js";
import { searchByGate } from "./embeddings.js";
import { EmbeddingDimensionMismatchError } from "../errors.js";

vi.mock("./db.js", () => ({ getDb: vi.fn() }));
const getDbMock = vi.mocked(getDb);

/** A drizzle-shaped query builder whose final `.limit()` rejects with `err`. */
function dbThatRejects(err: unknown) {
  const builder: Record<string, unknown> = { limit: () => Promise.reject(err) };
  builder.from = () => builder;
  builder.where = () => builder;
  builder.orderBy = () => builder;
  return { select: () => builder };
}

beforeEach(() => getDbMock.mockReset());

describe("searchByGate", () => {
  it("translates a pgvector dimension mismatch into an actionable error", async () => {
    getDbMock.mockReturnValue(
      dbThatRejects(new Error("different vector dimensions 768 and 1536")) as never,
    );

    const promise = searchByGate("gate", "tenant", [0.1], 5);

    await expect(promise).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
    await expect(promise).rejects.toThrow(/768.*1536/);
    await expect(promise).rejects.toThrow(/re-seed/);
  });

  it("rethrows unrelated query errors unchanged", async () => {
    const err = new Error("connection refused");
    getDbMock.mockReturnValue(dbThatRejects(err) as never);

    await expect(searchByGate("gate", "tenant", [0.1], 5)).rejects.toBe(err);
  });
});
