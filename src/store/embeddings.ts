import { eq, and, sql, isNull, isNotNull, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getDb } from "./db.js";
import { embeddings as embeddingsTable } from "./schema.js";
import type { EmbeddingRow, NewEmbedding, EmbeddingSource } from "./schema.js";

export type { EmbeddingRow, NewEmbedding };

export type SearchResult = {
  id: number;
  classId: number;
  gateName: string;
  label: string;
  content: string;
  source: EmbeddingSource;
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
  source: EmbeddingSource,
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
 * ANN search: find top-K nearest embeddings within a gate and tenant.
 * Uses pgvector cosine distance (`<=>`).
 */
export async function searchByGate(
  gateName: string,
  tenantId: string,
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
    .where(
      and(
        eq(embeddingsTable.gateName, gateName),
        or(eq(embeddingsTable.tenantId, tenantId), isNull(embeddingsTable.tenantId)),
      ),
    )
    .orderBy(sql`${embeddingsTable.embedding} <=> ${vectorStr}::vector`)
    .limit(topK);

  return rows;
}

/**
 * Delete all embeddings matching (tenantId, classId, contentHash, source).
 * Used to clear the opposite-signed evidence when feedback sign flips, e.g. a
 * stale negative guardrail when the user now confirms the intent.
 */
export async function deleteBySource(
  tenantId: string,
  classId: number,
  content: string,
  source: EmbeddingSource,
) {
  const db = getDb();
  await db
    .delete(embeddingsTable)
    .where(
      and(
        eq(embeddingsTable.tenantId, tenantId),
        eq(embeddingsTable.classId, classId),
        eq(embeddingsTable.contentHash, hashContent(content)),
        eq(embeddingsTable.source, source),
      ),
    );
}

export async function deleteById(id: number) {
  const db = getDb();
  await db.delete(embeddingsTable).where(eq(embeddingsTable.id, id));
}

/** Number of tenant-learned (feedback) embeddings for a class. */
export async function countLearntEmbeddingsByClass(classId: number): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(embeddingsTable)
    .where(and(eq(embeddingsTable.classId, classId), isNotNull(embeddingsTable.tenantId)));
  return row?.n ?? 0;
}
