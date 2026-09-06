import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pg from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { closeDb, getDb, initDb, runMigrations } from "../../src/store/db.js";

const POSTGRES_IMAGE = "pgvector/pgvector:pg16";

export type TestDatabase = {
  container: StartedPostgreSqlContainer;
  adminUrl: string;
};

/** Start a throwaway PostgreSQL container with the pgvector extension. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  return { container, adminUrl: container.getConnectionUri() };
}

/** Initialise the singleton database handle from a connection URL. */
export function connectDb(url: string) {
  initDb(url);
  return getDb();
}

export async function disconnectDb(): Promise<void> {
  await closeDb();
}

/** Absolute path of the drizzle migrations folder, independent of CWD. */
export function migrationsFolder(): string {
  return fileURLToPath(new URL("../../drizzle", import.meta.url));
}

/** Run the drizzle migrations against the currently initialised database. */
export async function migrate(): Promise<void> {
  await runMigrations(migrationsFolder());
}

/** Rewrite the admin connection URI to point at a named database. */
export function urlForDatabase(adminUrl: string, dbName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** Each test file gets its own database inside the shared container, so files never race on shared state. */
export async function createDatabase(adminUrl: string, dbName: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(adminUrl: string, dbName: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

export function uniqueDatabaseName(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Full reset for the integration layer: every table is emptied (tenants
 * included), so each test case starts from a clean schema and can reuse fixed
 * names.
 */
export async function resetDb(): Promise<void> {
  await getDb().execute(sql`
    TRUNCATE TABLE
      feedback,
      routing_events,
      promoted_keywords,
      embeddings,
      classes,
      gates,
      api_keys,
      tenants
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Partial reset for the end-to-end layer: keeps the seeded system gates, their
 * classes, and config embeddings, and only clears the data produced by tests.
 * `DELETE` is used (instead of `TRUNCATE ... CASCADE`) because truncating the
 * `tenants` table would cascade into the whole `gates` table and wipe the
 * system gates too.
 */
export async function resetE2eData(): Promise<void> {
  const db = getDb();
  await db.execute(sql`DELETE FROM feedback`);
  await db.execute(sql`DELETE FROM routing_events`);
  await db.execute(sql`DELETE FROM promoted_keywords`);
  await db.execute(sql`DELETE FROM api_keys`);
  await db.execute(sql`DELETE FROM gates WHERE tenant_id IS NOT NULL`);
}
