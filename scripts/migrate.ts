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

// Anchor the migrations folder to this script, independent of CWD.
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(here, "..", "drizzle");

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