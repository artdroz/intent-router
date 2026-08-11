import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.js";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _pool: pg.Pool | null = null;

export function initDb(databaseUrl: string) {
  if (_db) return _db;
  _pool = new pg.Pool({ connectionString: databaseUrl });
  _db = drizzle(_pool, { schema });
  return _db;
}

export function getDb() {
  if (!_db) throw new Error("Database not initialized. Call initDb() first.");
  return _db;
}

export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}

export async function runMigrations() {
  const db = getDb();
  await migrate(db, { migrationsFolder: "./drizzle" });
}
