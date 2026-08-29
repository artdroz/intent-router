import { and, eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { apiKeys, type ApiKeyRow } from "./schema.js";

export async function insertKey(
  row: Pick<ApiKeyRow, "tenantId" | "keyHash" | "prefix" | "name" | "expiresAt">,
) {
  const [inserted] = await getDb().insert(apiKeys).values(row).returning();
  return inserted;
}

export async function findKeyByHash(hash: string) {
  const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.keyHash, hash));
  return row ?? null;
}

export async function findKeyByName(tenantId: string, name: string) {
  const [row] = await getDb()
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.name, name)));
  return row ?? null;
}

export async function listKeys(tenantId: string) {
  return getDb()
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, tenantId))
    .orderBy(apiKeys.createdAt);
}

export async function updateKey(
  tenantId: string,
  name: string,
  patch: Partial<Pick<ApiKeyRow, "name" | "enabled" | "expiresAt">>,
) {
  const [updated] = await getDb()
    .update(apiKeys)
    .set(patch)
    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.name, name)))
    .returning();
  return updated ?? null;
}
