import { eq, and, sql } from "drizzle-orm";
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
}

const SEARCH_COLUMNS = {
  id: embeddingsTable.id,
  classId: embeddingsTable.classId,
  gateName: embeddingsTable.gateName,
  label: embeddingsTable.label,
  content: embeddingsTable.content,
  source: embeddingsTable.source,
};

export async function insertMany(rows: NewEmbedding[]) {
  if (rows.length === 0) return;
  const db = getDb();
  await db.insert(embeddingsTable).values(rows);
}

export async function deleteByClassId(classId: number, source?: string) {
  const db = getDb();
  const conditions = [eq(embeddingsTable.classId, classId)];
  if (source) conditions.push(eq(embeddingsTable.source, source));
  await db.delete(embeddingsTable).where(and(...conditions));
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

export async function getByClassId(
  classId: number,
  source?: string,
): Promise<EmbeddingRow[]> {
  const db = getDb();
  const conditions = [eq(embeddingsTable.classId, classId)];
  if (source) conditions.push(eq(embeddingsTable.source, source));

  return db
    .select()
    .from(embeddingsTable)
    .where(and(...conditions));
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