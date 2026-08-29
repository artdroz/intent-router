import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import * as gateStore from "../../store/gates.js";
import * as embeddingsStore from "../../store/embeddings.js";
import * as routingStore from "../../store/routing.js";
import { assertValidClasses, buildEmbeddingRows, indexClassUtterances } from "../service.js";
import type { DefaultGateDef } from "./service.js";

// Fixed app-wide lock ID so concurrent pods serialize seeding on the same lock.
const SEED_LOCK_ID = 1786551599371;

/**
 * Reconcile the default (system) gates from config into the DB.
 *
 * Idempotent and safe to run on every startup: creates missing gates/classes,
 * updates changed metadata/classes, re-indexes embeddings only when a class's
 * utterances changed, and deletes classes removed from config — but only when
 * no tenant has used them (no routing events or learnt embeddings).
 */
export async function seedDefaultGates(
  gates: DefaultGateDef[],
  databaseUrl: string,
): Promise<void> {
  if (gates.length === 0) return;

  const lockClient = new pg.Client({ connectionString: databaseUrl });
  await lockClient.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [SEED_LOCK_ID]);
    for (const def of gates) {
      assertValidClasses(def.classes.map((c) => ({ label: c.label, utterances: c.utterances })));
      await reconcileGate(def);
    }
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [SEED_LOCK_ID]).catch(() => {});
    await lockClient.end().catch(() => {});
  }
}

async function reconcileGate(def: DefaultGateDef): Promise<void> {
  const existing = await gateStore.getGateByName(def.name);

  if (!existing) {
    const raw = await gateStore.createGate(null, {
      name: def.name,
      description: def.description,
      config: def.config,
      classes: def.classes.map((c) => ({
        label: c.label,
        description: c.description,
        utterances: c.utterances ?? [],
        keywords: c.keywords ?? [],
      })),
    });
    if (!raw) throw new Error(`Failed to seed default gate "${def.name}"`);

    for (const c of raw.classes) {
      await indexClassUtterances(c.id, def.name, c.label, c.utterances);
    }
    return;
  }

  // Reconcile gate metadata (description/config) when changed.
  const metaChanged =
    (def.description ?? null) !== existing.gate.description ||
    !isDeepStrictEqual(def.config, existing.gate.config);
  if (metaChanged) {
    await gateStore.updateGate(def.name, {
      description: def.description,
      config: def.config,
    });
  }

  // Upsert classes present in config.
  for (const classDef of def.classes) {
    const utterances = classDef.utterances ?? [];
    const keywords = classDef.keywords ?? [];
    const existingClass = existing.classes.find((c) => c.label === classDef.label);

    if (!existingClass) {
      const inserted = await gateStore.addClass(def.name, {
        label: classDef.label,
        utterances,
        keywords,
      });
      if (!inserted) {
        throw new Error(`Failed to seed class "${classDef.label}" in gate "${def.name}"`);
      }
      await indexClassUtterances(inserted.id, def.name, inserted.label, utterances);
      continue;
    }

    const utterancesChanged = !sameList(existingClass.utterances, utterances);
    const keywordsChanged = !sameList(existingClass.keywords, keywords);
    if (!utterancesChanged && !keywordsChanged) continue;

    await gateStore.updateClass(def.name, classDef.label, { utterances, keywords });

    if (utterancesChanged) {
      const rows = await buildEmbeddingRows(existingClass.id, def.name, classDef.label, utterances);
      await embeddingsStore.replaceClassEmbeddings(existingClass.id, "config", rows);
    }
  }

  // Delete classes removed from config — but only when unused, so tenant
  // feedback/learning history is never destroyed by a config edit.
  // The classes with usage history are kept, and a warning is logged to alert the operator.
  const configuredLabels = new Set(def.classes.map((c) => c.label));
  for (const c of existing.classes) {
    if (configuredLabels.has(c.label)) continue;

    const used =
      (await routingStore.countRoutingEventsByClass(c.id)) > 0 ||
      (await embeddingsStore.countLearntEmbeddingsByClass(c.id)) > 0;

    if (used) {
      console.warn(
        `Keeping removed class "${c.label}" in default gate "${def.name}" — it has usage history`,
      );
      continue;
    }

    await gateStore.deleteClass(def.name, c.label);
    console.log(`Deleted unused class "${c.label}" from default gate "${def.name}"`);
  }
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
