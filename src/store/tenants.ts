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
