/**
 * Remove evaluation artifacts from the database.
 *
 * Deletes the dedicated "eval" tenant. Its API keys, gates, classes, and
 * embeddings are removed via ON DELETE CASCADE (gates and embeddings reference
 * the tenant; classes cascade from gates; config embeddings cascade from
 * classes). App-owned tenants (e.g. "demo") are left untouched.
 *
 * Usage:
 *   npx tsx evaluate/evaluator/eval-cleanup.ts
 */

import { eq } from "drizzle-orm";
import { getDb, initDb } from "../../src/store/db.js";
import { tenants } from "../../src/store/schema.js";
import { DATABASE_URL } from "./config.js";

async function main() {
  const url = DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required — set it or create a .env");
    process.exit(1);
  }

  initDb(url);
  const db = getDb();

  const deleted = await db
    .delete(tenants)
    .where(eq(tenants.name, "eval"))
    .returning({ id: tenants.id });

  if (deleted.length === 0) {
    console.log("No 'eval' tenant found — database is already clean.");
    return;
  }

  console.log(
    `Deleted eval tenant(s) ${deleted.map((d) => d.id).join(", ")} ` +
      "(API keys, gates, classes, embeddings cascade).",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Cleanup failed:", err);
    process.exit(1);
  });
