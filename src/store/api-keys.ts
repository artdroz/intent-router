import { and, eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { apiKeys, type ApiKeyRow } from "./schema.js";

/** Insert a new API-key row. */
export async function insertKey(
  row: Pick<ApiKeyRow, "tenantId" | "keyHash" | "prefix" | "name" | "expiresAt">,
) {
  const db = getDb();
  const [inserted] = await db.insert(apiKeys).values(row).returning();
  return inserted;
}

/** Look up a key by its SHA-256 hash. */
export async function findKeyByHash(hash: string) {
  const db = getDb();
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash));
  return row ?? null;
}

/** Look up a key by tenant and name. */
export async function findKeyByName(tenantId: string, name: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.name, name)));
  return row ?? null;
}

/** List a tenant's keys ordered by creation time. */
export async function listKeys(tenantId: string) {
  const db = getDb();
  return db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantId)).orderBy(apiKeys.createdAt);
}

/** Patch a key's name, enabled flag, or expiry; returns null when not found. */
export async function updateKey(
  tenantId: string,
  name: string,
  patch: Partial<Pick<ApiKeyRow, "name" | "enabled" | "expiresAt">>,
) {
  const db = getDb();
  const [updated] = await db
    .update(apiKeys)
    .set(patch)
    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.name, name)))
    .returning();
  return updated ?? null;
}
