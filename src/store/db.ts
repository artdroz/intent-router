import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.js";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function initDb(databaseUrl: string) {
  if (_db) return _db;                          // idempotent — safe to call in tests
  const pool = new pg.Pool({ connectionString: databaseUrl });
  _db = drizzle(pool, { schema });
  return _db;
}

export function getDb() {
  if (!_db) throw new Error("Database not initialized. Call initDb() first.");
  return _db;
}

export async function runMigrations() {
  const db = getDb();
  await migrate(db, { migrationsFolder: "./drizzle" });
}
