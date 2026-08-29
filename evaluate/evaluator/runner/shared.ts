/**
 * Shared evaluation harness — types, data loading, DB init, and cost metrics.
 *
 * Used by:
 *   - classifier.ts      (classifier accuracy eval)
 *   - router.ts          (cascade router eval with LLM)
 *   - router-pre-cascade.ts  (pre-cascade tuning, no LLM)
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { eq } from "drizzle-orm";
import { getDb, initDb } from "../../../src/store/db.js";
import { createGate } from "../../../src/store/gates.js";
import { insertMany, type NewEmbeddingInput } from "../../../src/store/embeddings.js";
import { findKeyByName, insertKey } from "../../../src/store/api-keys.js";
import { gates as gatesTable, classes as classesTable, tenants as tenantsTable } from "../../../src/store/schema.js";
import { createEmbedClient } from "../../../src/lib/embed-client.js";
import type { Gate } from "../../../src/gates/types.js";
import { DEFAULT_EMBEDDING_URL, DEFAULT_EMBEDDING_MODEL } from "../config.js";

// Load .env so standalone `npx tsx ...` runs pick up DATABASE_URL / API keys.
try {
  process.loadEnvFile?.();
} catch {
  // No .env file — rely on ambient environment variables.
}

// ── Dataset Types ──

export interface DatasetRow {
  id: string;
  label: string;
  prompt: string;
}

export interface DatasetConfig {
  gate: {
    name: string;
    description: string;
    classes: Array<{
      label: string;
      description: string;
      utterances: string[];
      keywords: string[];
    }>;
  };
}

// ── Base CLI Args (extended per evaluator) ──

export interface BaseArgs {
  dataset: string;
  set: string;
  verbose: boolean;
  limit?: number;
  embeddingUrl: string;
  embeddingModel: string;
}

// ── Data Loading ──

export function loadConfig(dataset: string): DatasetConfig {
  const path = `evaluate/dataset/${dataset}/${dataset}.config.json`;
  return JSON.parse(readFileSync(path, "utf-8")) as DatasetConfig;
}

export function loadDataset(dataset: string, split?: string): DatasetRow[] {
  const suffix = split ? `.${split}` : "";
  const path = `evaluate/dataset/${dataset}/${dataset}${suffix}.jsonl`;
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DatasetRow);
}

export function buildGate(config: DatasetConfig): Gate {
  return {
    id: 0,
    name: config.gate.name,
    description: config.gate.description,
    config: { learningEnabled: true },
    classes: config.gate.classes.map((c) => ({
      label: c.label,
      description: c.description,
      utterances: c.utterances,
      keywords: c.keywords,
      promotedKeywords: [],
    })),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ── DB Init + Seeding ──

export interface DbContext {
  /** Embed function (only available when indexEmbeddings=true). */
  embed?: (text: string) => Promise<number[]>;
}

/**
 * Initialize the Postgres DB, seed the gate (classes + labels), and optionally
 * index utterance embeddings. Returns an { embed } function if embeddings were indexed.
 *
 * Requires DATABASE_URL to be set and migrations already applied
 * (run `npm run db:migrate` first, matching scripts/migrate.ts).
 */
export async function initDbAndSeed(
  config: DatasetConfig,
  opts: {
    indexEmbeddings?: boolean;
    embeddingUrl?: string;
    embeddingModel?: string;
  } = {},
): Promise<DbContext> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required — run with env set (e.g. `DATABASE_URL=... npx tsx ...`).",
    );
  }
  initDb(databaseUrl);

  // Seed labels: create (or reuse) the gate with its classes.
  const apiKey = await ensureEvalApiKey();
  const gate = await getOrCreateGate(apiKey.tenantId, config);
  if (!gate) throw new Error(`Failed to create gate "${config.gate.name}"`);

  // Index embeddings
  if (opts.indexEmbeddings) {
    const embedder = createEmbedClient({
      baseUrl: opts.embeddingUrl ?? DEFAULT_EMBEDDING_URL,
      model: opts.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
    });
    const rows: NewEmbeddingInput[] = [];
    for (const cls of gate.classes) {
      for (const utterance of cls.utterances) {
        rows.push({
          classId: cls.id,
          gateName: gate.gate.name,
          label: cls.label,
          content: utterance,
          source: "config",
          embedding: await embedder.embed(utterance),
        });
      }
    }
    await insertMany(rows);
    console.log(
      `Indexed ${rows.length} embeddings for ${gate.classes.length} classes.`,
    );
    return { embed: embedder.embed };
  }

  return {};
}

const EVAL_API_KEY_NAME = "eval";
const EVAL_TENANT_NAME = "eval";

/** Ensure the eval tenant exists (created lazily on first run). */
async function ensureEvalTenant() {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.name, EVAL_TENANT_NAME));
  if (existing) return existing;
  const [created] = await db
    .insert(tenantsTable)
    .values({ name: EVAL_TENANT_NAME })
    .returning();
  return created;
}

/** Ensure a dedicated API key exists so gates can be created for evaluation. */
async function ensureEvalApiKey() {
  const tenant = await ensureEvalTenant();
  const existing = await findKeyByName(tenant.id, EVAL_API_KEY_NAME);
  if (existing) return existing;
  return insertKey({
    tenantId: tenant.id,
    keyHash: `eval-${Date.now()}`,
    prefix: "eval",
    name: EVAL_API_KEY_NAME,
    expiresAt: null,
  });
}

/** Create the gate if it doesn't exist; otherwise reuse the existing rows. */
async function getOrCreateGate(tenantId: string, config: DatasetConfig) {
  const existing = await getGateByNameGlobal(config.gate.name);
  if (existing) return existing;

  return createGate(tenantId, {
    name: config.gate.name,
    description: config.gate.description,
    config: { learningEnabled: true },
    classes: config.gate.classes.map((c) => ({
      label: c.label,
      description: c.description,
      utterances: c.utterances,
      keywords: c.keywords,
    })),
  });
}

/** Look up a gate by its globally unique name (ignoring API-key scope). */
async function getGateByNameGlobal(name: string) {
  const db = getDb();
  const [gate] = await db.select().from(gatesTable).where(eq(gatesTable.name, name));
  if (!gate) return null;
  const rows = await db.select().from(classesTable).where(eq(classesTable.gateId, gate.id));
  return { gate, classes: rows };
}

// ── Output Helpers ──

export function formatProbs(probs: Record<string, number>): string {
  return Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .map(([label, prob]) => `${label}=${prob.toFixed(3)}`)
    .join("  ");
}

/** Shared per-class accuracy table printer. */
export function printPerClassSummary(
  results: Array<{ expected?: string; truth?: string; correct: boolean }>,
): void {
  const byClass = new Map<string, { total: number; correct: number }>();
  for (const r of results) {
    const label = (r as any).expected ?? (r as any).truth;
    const s = byClass.get(label) ?? { total: 0, correct: 0 };
    s.total++;
    if (r.correct) s.correct++;
    byClass.set(label, s);
  }
  for (const [label, s] of byClass) {
    console.log(
      `  ${label}: ${s.correct}/${s.total} (${((s.correct / s.total) * 100).toFixed(1)}%)`,
    );
  }
}

// ── Raw Per-Prompt Types (written to runs/ JSONL) ──

export interface ClassifierPrompt {
  id: string;
  truth: string;
  predicted: string;
  correct: boolean;
  scores: Record<string, number>;
  latencyMs: number;
}

export interface PreCascadePrompt {
  id: string;
  truth: string;
  predicted: string;
  correct: boolean;
  margin: number;
  entropy: number;
  cascade: boolean;
  scores: Record<string, number>;
  latencyMs: number;
}

export interface RouterPrompt {
  id: string;
  truth: string;
  predicted: string;
  correct: boolean;
  cascaded: boolean;
  preLatencyMs: number;
  llmLatencyMs: number;
  totalLatencyMs: number;
}

// ── Run I/O ──

import { RUNS_DIR } from "../config.js";

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Write an array of per-prompt results as JSONL to `runs/...`.
 * Returns the absolute file path written.
 */
export function writeRun(filePath: string, prompts: object[]): string {
  const fullPath = join(RUNS_DIR, filePath);
  ensureDir(dirname(fullPath));
  const lines = prompts.map((p) => JSON.stringify(p)).join("\n") + "\n";
  writeFileSync(fullPath, lines, "utf-8");
  return fullPath;
}

// ── CLI Helper ──

/** Parse shared CLI flags.  Each evaluator extends the returned object. */
export function parseBaseArgs(): Record<string, string> {
  const raw: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1]?.startsWith("--") ? "true" : argv[++i];
      raw[key] = val ?? "true";
    }
  }
  return raw;
}
