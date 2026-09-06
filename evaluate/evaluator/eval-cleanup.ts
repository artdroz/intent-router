/**
 * Remove evaluation artifacts from the database.
 *
 * Two levels:
 *   clearLearnedState() — delete only the *learned* state (routing events +
 *     feedback, promoted keywords, learned embeddings) for the "eval" tenant,
 *     keeping the tenant, gates, classes, and config embeddings intact so they
 *     are not re-embedded on every run.
 *   main()               — delete the whole "eval" tenant (cascade), for a full
 *     reset.
 *
 * Usage:
 *   npx tsx evaluate/evaluator/eval-cleanup.ts
 */

import { eq } from "drizzle-orm";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, initDb } from "../../src/store/db.js";
import {
  tenants,
  routingEvents,
  promotedKeywords,
  embeddings,
} from "../../src/store/schema.js";
import { DATABASE_URL } from "./config.js";

/** Delete learned state only, keeping config (tenant, gates, config embeddings). */
export async function clearLearnedState() {
  const url = DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required — set it or create a .env");
  }
  initDb(url);
  const db = getDb();

  const [tenant] = await db.select().from(tenants).where(eq(tenants.name, "eval"));
  if (!tenant) {
    console.log("No 'eval' tenant found — nothing to clear.");
    return;
  }

  // feedback rows cascade from routing_events via route_id.
  const events = await db
    .delete(routingEvents)
    .where(eq(routingEvents.tenantId, tenant.id))
    .returning({ routeId: routingEvents.routeId });
  const promoted = await db
    .delete(promotedKeywords)
    .where(eq(promotedKeywords.tenantId, tenant.id))
    .returning({ tenantId: promotedKeywords.tenantId });
  const learned = await db
    .delete(embeddings)
    .where(eq(embeddings.tenantId, tenant.id))
    .returning({ id: embeddings.id });

  console.log(
    `Cleared learned state: ${events.length} routing events, ` +
      `${promoted.length} promoted-keyword rows, ${learned.length} learned embeddings.`,
  );
}

/** Full reset: delete the whole "eval" tenant (cascades to keys/gates/classes/embeddings). */
export async function main() {
  const url = DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required — set it or create a .env");
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Cleanup failed:", err);
      process.exit(1);
    });
}
