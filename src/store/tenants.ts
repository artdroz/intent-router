import { eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { tenants } from "./schema.js";

/** Look up a tenant by name. */
export async function findTenantByName(name: string) {
  const db = getDb();
  const [row] = await db.select().from(tenants).where(eq(tenants.name, name));
  return row ?? null;
}

/** Create a tenant. */
export async function createTenant(name: string) {
  const db = getDb();
  const [row] = await db.insert(tenants).values({ name }).returning();
  return row;
}

/**
 * Look up a tenant by name, creating it first when missing.
 *
 * Idempotent and safe under concurrent callers: `tenants.name` is unique, so
 * the `ON CONFLICT DO NOTHING` insert either wins or defers to an existing row.
 */
export async function findOrCreateTenant(name: string) {
  const db = getDb();
  const inserted = await db
    .insert(tenants)
    .values({ name })
    .onConflictDoNothing({ target: tenants.name })
    .returning();
  if (inserted.length > 0) return inserted[0];

  const [row] = await db.select().from(tenants).where(eq(tenants.name, name));
  return row ?? null;
}
