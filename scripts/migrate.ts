/**
 * Apply the Drizzle schema migrations, then exit.
 *
 * Takes a Postgres advisory lock for the whole run so concurrent migrators
 * serialize. In production this runs as a one-shot Job / PreSync hook before
 * the app rollout; locally it bootstraps a fresh database.
 *
 * Prerequisite: DATABASE_URL points at a running Postgres. The migrations
 * live in drizzle/ and are located relative to this script, not the CWD.
 *
 * Usage:
 *   npm run db:migrate:prod
 *   # or directly (compiled build):
 *   node dist/scripts/migrate.js
 *
 * Output: prints "Migrations complete." or the failure message. Side effect:
 * brings the database schema up to date.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { closeDb, initDb, runMigrations } from "../src/store/db.js";

// Fixed, app-wide lock ID so concurrent migrators serialize on the same lock.
const MIGRATION_LOCK_ID = 1786551599369;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

// Locate the drizzle/ migrations folder relative to this script, independent
// of CWD. Works when run from source (tsx scripts/migrate.ts → <root>/scripts)
// and from the compiled build (node dist/scripts/migrate.js → <root>/dist/scripts):
// walk up from the script's own directory until a "drizzle" dir is found.
function findMigrationsFolder(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "drizzle");
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("Could not locate the drizzle/ migrations folder");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = findMigrationsFolder(here);

// Hold a session-level advisory lock across the whole migration run so
// multiple pods starting at once don't apply the same migration concurrently.
const lockClient = new pg.Client({ connectionString: url });
let exitCode = 0;

try {
  await lockClient.connect();
  await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);

  initDb(url);
  await runMigrations(migrationsFolder);
  console.log("Migrations complete.");
} catch (err) {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  exitCode = 1;
} finally {
  await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
  await lockClient.end().catch(() => {});
  await closeDb();
}

process.exit(exitCode);