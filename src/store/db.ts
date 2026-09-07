import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.js";
import { InternalError } from "../errors.js";

// Process-wide singletons, initialized once at bootstrap.
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let pool: pg.Pool | null = null;

/** Initialize the process-wide Drizzle client and connection pool (idempotent). */
export function initDb(databaseUrl: string) {
  if (db) return db;
  pool = new pg.Pool({ connectionString: databaseUrl });
  db = drizzle(pool, { schema });
  return db;
}

/** Return the initialized Drizzle client, or throw if `initDb` has not run. */
export function getDb() {
  if (!db) throw new InternalError("Database not initialized. Call initDb() first.");
  return db;
}

/** End the connection pool; used during graceful shutdown. */
export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

/** Apply Drizzle migrations from a folder. */
export async function runMigrations(migrationsFolder: string) {
  const db = getDb();
  await migrate(db, { migrationsFolder });
}
