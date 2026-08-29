import { eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { tenants } from "./schema.js";

export async function findTenantByName(name: string) {
  const db = getDb();
  const [row] = await db.select().from(tenants).where(eq(tenants.name, name));
  return row ?? null;
}

export async function createTenant(name: string) {
  const db = getDb();
  const [row] = await db.insert(tenants).values({ name }).returning();
  return row;
}
