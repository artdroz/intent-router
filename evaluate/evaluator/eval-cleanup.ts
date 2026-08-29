/**
 * Remove evaluation artifacts from the database.
 *
 * Deletes the dedicated "eval" API key. Its gates → classes → embeddings are
 * removed via ON DELETE CASCADE. App-owned gates (e.g. under the "demo" key)
 * are left untouched.
 *
 * Usage:
 *   npx tsx evaluate/evaluator/eval-cleanup.ts
 */

import { eq } from "drizzle-orm";
import { getDb, initDb } from "../../src/store/db.js";
import { apiKeys } from "../../src/store/schema.js";

try {
  process.loadEnvFile?.();
} catch {
  // no .env — rely on ambient environment
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required — set it or create a .env");
    process.exit(1);
  }

  initDb(url);
  const db = getDb();

  const deleted = await db
    .delete(apiKeys)
    .where(eq(apiKeys.name, "eval"))
    .returning({ id: apiKeys.id });

  if (deleted.length === 0) {
    console.log("No 'eval' API key found — database is already clean.");
    return;
  }

  console.log(
    `Deleted eval API key(s) ${deleted.map((d) => d.id).join(", ")} ` +
      "(gates/classes/embeddings cascade).",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Cleanup failed:", err);
    process.exit(1);
  });
