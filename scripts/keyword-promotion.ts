/**
 * Run the keyword-promotion learning pass once.
 *
 * Scores accumulated feedback with TF-IDF and upserts the top promoted
 * keywords per (tenant, class) into promoted_keywords. In production this runs
 * as a scheduled CronJob; this script runs the same pass manually. Gates with
 * fewer than LRN_MIN_FEEDBACK_ROWS feedback rows, or a single class, are
 * skipped.
 *
 * Prerequisite: DATABASE_URL points at a running Postgres; feedback must have
 * been submitted first (there is nothing to learn from otherwise).
 *
 * Usage:
 *   npx tsx scripts/keyword-promotion.ts
 *   # or from the compiled build:
 *   node dist/scripts/keyword-promotion.js
 *
 * Output: prints "Keyword promotion complete.". Side effect: updates the
 * promoted_keywords table.
 */

import { closeDb, initDb } from "../src/store/db.js";
import { promoteKeyword } from "../src/routing/service.js";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(1); }

initDb(url);

try {
  await promoteKeyword();
  console.log("Keyword promotion complete.");
} finally {
  await closeDb();
}

process.exit(0);