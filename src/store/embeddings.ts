import { eq, and, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getDb } from "./db.js";
import { embeddings as embeddingsTable } from "./schema.js";
import type { EmbeddingRow, NewEmbedding } from "./schema.js";

export type { EmbeddingRow, NewEmbedding };

export type SearchResult = {
  id: number;
  classId: number;
  gateName: string;
  label: string;
  content: string;
  source: string;
  distance: number;
};

const SEARCH_COLUMNS = {
  id: embeddingsTable.id,
  classId: embeddingsTable.classId,
  gateName: embeddingsTable.gateName,
  label: embeddingsTable.label,
  content: embeddingsTable.content,
  source: embeddingsTable.source,
};

/** Input rows without contentHash — computed internally. */
export type NewEmbeddingInput = Omit<NewEmbedding, "contentHash">;

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Bulk insert embeddings, deduplicated by (classId, contentHash).
 * Duplicate rows are silently skipped via ON CONFLICT DO NOTHING.
 */
export async function insertMany(rows: NewEmbeddingInput[]) {
  if (rows.length === 0) return;
  const db = getDb();
  await db
    .insert(embeddingsTable)
    .values(rows.map((r) => ({ ...r, contentHash: hashContent(r.content) })))
    .onConflictDoNothing();
}

/**
 * Atomically replace all embeddings of a class+source with a fresh set.
 * Used when re-indexing config utterances: delete old + insert new in one transaction.
 */
export async function replaceClassEmbeddings(
  classId: number,
  source: string,
  rows: NewEmbeddingInput[],
) {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx
      .delete(embeddingsTable)
      .where(and(eq(embeddingsTable.classId, classId), eq(embeddingsTable.source, source)));

    if (rows.length > 0) {
      await tx
        .insert(embeddingsTable)
        .values(rows.map((r) => ({ ...r, contentHash: hashContent(r.content) })));
    }
  });
}

/**
 * ANN search: find top-K nearest embeddings within a gate.
 * Uses pgvector cosine distance (`<=>`).
 */
export async function searchByGate(
  gateName: string,
  embedding: number[],
  topK: number,
): Promise<SearchResult[]> {
  const db = getDb();
  const vectorStr = `[${embedding.join(",")}]`;

  const rows = await db
    .select({
      ...SEARCH_COLUMNS,
      distance: sql<number>`${embeddingsTable.embedding} <=> ${vectorStr}::vector`,
    })
    .from(embeddingsTable)
    .where(eq(embeddingsTable.gateName, gateName))
    .orderBy(sql`${embeddingsTable.embedding} <=> ${vectorStr}::vector`)
    .limit(topK);

  return rows;
}

/**
 * ANN search: find top-K nearest embeddings within a class.
 */
export async function searchByClassId(
  classId: number,
  embedding: number[],
  topK: number,
): Promise<SearchResult[]> {
  const db = getDb();
  const vectorStr = `[${embedding.join(",")}]`;

  return db
    .select({
      ...SEARCH_COLUMNS,
      distance: sql<number>`${embeddingsTable.embedding} <=> ${vectorStr}::vector`,
    })
    .from(embeddingsTable)
    .where(eq(embeddingsTable.classId, classId))
    .orderBy(sql`${embeddingsTable.embedding} <=> ${vectorStr}::vector`)
    .limit(topK);
}

export async function deleteById(id: number) {
  const db = getDb();
  await db.delete(embeddingsTable).where(eq(embeddingsTable.id, id));
}
