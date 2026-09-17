/**
 * Run the LLM-as-judge internal-learning pass once.
 *
 * Samples unjudged routing events (uncertainty-first plus a stratified random
 * exploration slice), asks the judge LLM for gold labels, and writes those
 * labels back into feedback and embeddings. In production this runs as a
 * scheduled CronJob; this script runs the same pass manually.
 *
 * Prerequisite: DATABASE_URL points at a running Postgres; JUDGE_MODEL,
 * EMBED_BASE_URL and EMBED_MODEL are required so the judge can label and the
 * embedding pipeline can learn.
 *
 * Usage:
 *   npx tsx scripts/internal-learning.ts
 *   # or from the compiled build:
 *   node dist/scripts/internal-learning.js
 *
 * Output: prints "Internal learning complete. judged=<n> failed=<n>".
 * Side effect: inserts judge_labels, feedback and learning embeddings.
 */

import { initEmbedClient } from "../src/clients/embed-client.js";
import { initLlmClient } from "../src/clients/llm-client.js";
import { learnInternally } from "../src/routing/judge.js";
import { closeDb, initDb } from "../src/store/db.js";

const databaseUrl = process.env.DATABASE_URL;
const judgeBaseUrl = process.env.JUDGE_BASE_URL;
const judgeModel = process.env.JUDGE_MODEL;
const embedBaseUrl = process.env.EMBED_BASE_URL;
const embedModel = process.env.EMBED_MODEL;
if (!databaseUrl || !judgeModel || !judgeBaseUrl || !embedBaseUrl || !embedModel) {
  console.error("DATABASE_URL, JUDGE_MODEL, JUDGE_BASE_URL, EMBED_BASE_URL and EMBED_MODEL are required");
  process.exit(1);
}

initDb(databaseUrl);
initEmbedClient({
  baseUrl: embedBaseUrl,
  model: embedModel,
  apiKey: process.env.EMBED_API_KEY || undefined,
  dims: process.env.EMBED_DIMS ? Number(process.env.EMBED_DIMS) : undefined,
});

const judge = initLlmClient({
  baseUrl: judgeBaseUrl,
  model: judgeModel,
  apiKey: process.env.JUDGE_API_KEY || undefined,
});

try {
  const budget = process.env.INTERNAL_LEARNING_BUDGET
    ? Number(process.env.INTERNAL_LEARNING_BUDGET)
    : undefined;
  const { judged, failed } = await learnInternally(judge, { model: judgeModel, budget });
  console.log(`Internal learning complete. judged=${judged} failed=${failed}`);
} finally {
  await closeDb();
}

process.exit(0);
