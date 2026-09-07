/**
 * Shared evaluation harness — types, data loading, DB init, and cost metrics.
 *
 * Used by:
 *   - classifier.ts      (classifier accuracy eval)
 *   - pre-cascade.ts     (pre-cascade tuning, no LLM)
 *   - router.ts          (cascade router eval with LLM)
 *   - tune-thresholds.ts (threshold sweep over val runs)
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { eq, and, isNull } from "drizzle-orm";
import { getDb, initDb } from "../../../src/store/db.js";
import { createGate } from "../../../src/store/gates.js";
import { insertMany, type NewEmbeddingInput } from "../../../src/store/embeddings.js";
import { findKeyByName, insertKey } from "../../../src/store/api-keys.js";
import { gates as gatesTable, classes as classesTable, tenants as tenantsTable, embeddings as embeddingsTable } from "../../../src/store/schema.js";
import { createEmbedClient, type EmbedClient } from "../../../src/clients/embed-client.js";
import { initLlmClient, type LlmClient } from "../../../src/clients/llm-client.js";
import type { Gate } from "../../../src/gates/types.js";
import {
  DATABASE_URL,
  DEFAULT_EMBEDDING_URL,
  DEFAULT_EMBEDDING_MODEL,
  EMBED_API_KEY,
  EMBED_DIMS,
  LLM_API_KEY,
  REQUEST_INTERVAL_MS,
  RETRY_DELAY_MS,
} from "../config.js";
import { clearLearnedState } from "../eval-cleanup.js";

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

/**
 * The dataset files under evaluate/dataset/ use the flat naming convention
 *   {dataset}-fnl-company-opus.{split}.jsonl
 * e.g. k8-fnl-company-opus.val.jsonl.  They also carry the label in either
 * `adaptive_label` (request_type taxonomy) or `complexity_label`
 * (complexity_tier taxonomy) rather than a bare `label` field.
 *
 * Legacy per-dataset directories (evaluate/dataset/{dataset}/) are still
 * supported for backwards compatibility.
 */
const FLAT_DATASET_INFIX = "-fnl-company-opus";

/**
 * Known label taxonomies.  Each dataset row carries one of these fields; the
 * value selects both the gate config file and the gate (directory) name used
 * for run/metric output.
 */
const TAXONOMIES: Record<string, { configFile: string; gateName: string }> = {
  adaptive_label: { configFile: "request_type.config.json", gateName: "request_type" },
  complexity_label: { configFile: "complexity_tier.config.json", gateName: "complexity_tier" },
};

/** Aliases so `--label-field` also accepts the gate/taxonomy name. */
const LABEL_FIELD_ALIASES: Record<string, string> = {
  request_type: "adaptive_label",
  complexity_tier: "complexity_label",
};

/** Resolve which dataset field holds the ground-truth label. */
export function resolveLabelField(raw: Record<string, string>): string {
  const field = raw["label-field"] ?? process.env.LABEL_FIELD ?? "adaptive_label";
  return LABEL_FIELD_ALIASES[field] ?? field;
}

/** The gate name (run/metric directory) for a label field. */
export function gateNameFor(labelField: string): string {
  return TAXONOMIES[labelField]?.gateName ?? labelField;
}

function resolveConfigPath(dataset: string, labelField: string): string {
  const taxonomy = TAXONOMIES[labelField];
  if (taxonomy) {
    const flatPath = `evaluate/dataset/${taxonomy.configFile}`;
    if (existsSync(flatPath)) return flatPath;
  }
  const legacyPath = `evaluate/dataset/${dataset}/${dataset}.config.json`;
  if (existsSync(legacyPath)) return legacyPath;
  throw new Error(
    `No gate config found for dataset "${dataset}" (label field "${labelField}"). ` +
      `Expected a taxonomy config (${Object.values(TAXONOMIES).map((t) => t.configFile).join(", ")}) ` +
      `or ${legacyPath}.`,
  );
}

export function loadConfig(
  dataset: string,
  labelField: string = "adaptive_label",
): DatasetConfig {
  const path = resolveConfigPath(dataset, labelField);
  return JSON.parse(readFileSync(path, "utf-8")) as DatasetConfig;
}

function resolveDatasetPath(dataset: string, split?: string): string {
  const suffix = split ? `.${split}` : "";
  const candidates = [
    `evaluate/dataset/${dataset}/${dataset}${suffix}.jsonl`,
    `evaluate/dataset/${dataset}${suffix}.jsonl`,
    `evaluate/dataset/${dataset}${FLAT_DATASET_INFIX}${suffix}.jsonl`,
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    throw new Error(
      `Dataset file not found for "${dataset}" (split "${split ?? "-"}"). Tried:\n` +
        candidates.map((c) => `  - ${c}`).join("\n"),
    );
  }
  return path;
}

export function loadDataset(
  dataset: string,
  split?: string,
  labelField: string = "adaptive_label",
): DatasetRow[] {
  const path = resolveDatasetPath(dataset, split);
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const label = obj[labelField] ?? obj["label"];
      if (typeof label !== "string" || typeof obj.prompt !== "string") {
        throw new Error(
          `Row in ${path} is missing "${labelField}" (or "label") or "prompt".`,
        );
      }
      return { id: String(obj.id), label, prompt: obj.prompt };
    });
}

/** Return a deterministically shuffled copy without mutating the input rows. */
export function shuffleDataset<T>(rows: T[], seed: number): T[] {
  if (!Number.isFinite(seed)) {
    throw new Error(`Shuffle seed must be a finite number, got: ${seed}`);
  }

  const shuffled = rows.slice();
  let state = Math.trunc(seed) >>> 0;

  const nextRandom = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(nextRandom() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

// ── Client Construction ──

/**
 * Normalize a base URL for the OpenAI-compatible clients.  Both clients append
 * their own `/v1/...` path, so a base URL that already ends in `/v1` (e.g. the
 * `*_BASE_URL` values in .env) must have that suffix stripped first.
 */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared throttle across both clients (they hit the same host): guarantees a
// minimum gap between outbound requests to stay under the endpoint rate limit.
let lastRequestAt = 0;
let throttleQueue: Promise<void> = Promise.resolve();

function throttleRequest(): Promise<void> {
  const next = throttleQueue.then(async () => {
    const now = Date.now();
    const wait = lastRequestAt + REQUEST_INTERVAL_MS - now;
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  throttleQueue = next.catch(() => {});
  return next;
}

/**
 * Retry a client call forever with a fixed delay, until the process is killed
 * (rides out transient 429/403 from the company LLM/embed endpoint).
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[retry] ${label} attempt ${attempt} failed: ${msg} — retrying in ${RETRY_DELAY_MS / 1000}s (Ctrl+C to stop)`,
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/** Embed client wired with EMBED_API_KEY / EMBED_DIMS, throttled and retried. */
export function makeEmbedClient(url: string, model: string): EmbedClient {
  const client = createEmbedClient({
    baseUrl: normalizeBaseUrl(url),
    model,
    apiKey: EMBED_API_KEY,
    dims: EMBED_DIMS,
  });
  return {
    get dims() {
      return client.dims;
    },
    embed: (text) =>
      withRetry(`embed (${model})`, async () => {
        await throttleRequest();
        return client.embed(text);
      }),
  };
}

/** LLM client wired with LLM_API_KEY, throttled and retried. */
export function makeLlmClient(url: string, model: string) {
  const client = initLlmClient({
    baseUrl: normalizeBaseUrl(url),
    model,
    apiKey: LLM_API_KEY,
  });
  const complete: LlmClient["complete"] = (messages, responseFormat) =>
    withRetry(`llm (${model})`, async () => {
      await throttleRequest();
      return client.complete(messages, responseFormat);
    });
  return { complete };
}

export function buildGate(config: DatasetConfig): Gate {
  return {
    id: 0,
    tenantId: null,
    name: config.gate.name,
    description: config.gate.description,
    config: { learningEnabled: true },
    classes: config.gate.classes.map((c) => ({
      id: 0,
      label: c.label,
      description: c.description,
      utterances: c.utterances,
      keywords: c.keywords,
    })),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ── DB Init + Seeding ──

export interface DbContext {
  /** Tenant the seeded gate belongs to. */
  tenantId: string;
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
  const databaseUrl = DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required — run with env set (e.g. `DATABASE_URL=... npx tsx ...`).",
    );
  }
  initDb(databaseUrl);

  // Seed labels: create (or reuse) the gate with its classes. Only the
  // *learned* state is wiped between runs; the tenant, gate, classes and config
  // embeddings are kept so they are not re-embedded on every round.
  await clearLearnedState();
  const apiKey = await ensureEvalApiKey();
  const gate = await getOrCreateGate(apiKey.tenantId, config);
  if (!gate) throw new Error(`Failed to create gate "${config.gate.name}"`);

  // Index embeddings (skip if this gate's config embeddings are already indexed)
  if (opts.indexEmbeddings) {
    const embedder = makeEmbedClient(
      opts.embeddingUrl ?? DEFAULT_EMBEDDING_URL,
      opts.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
    );
    const db = getDb();
    const [existing] = await db
      .select({ id: embeddingsTable.id })
      .from(embeddingsTable)
      .where(and(eq(embeddingsTable.gateName, gate.gate.name), isNull(embeddingsTable.tenantId)))
      .limit(1);
    if (!existing) {
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
    } else {
      console.log(`Config embeddings for "${gate.gate.name}" already indexed — skipping.`);
    }
    return { tenantId: apiKey.tenantId, embed: embedder.embed };
  }

  return { tenantId: apiKey.tenantId };
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

/** Per-prompt result of the sequential three-tier (keyword → semantic → LLM) cascade. */
export interface ThreeTierPrompt {
  id: string;
  truth: string;
  predicted: string;
  correct: boolean;
  /** True when the gatekeeper would defer to the LLM (both tiers uncertain). */
  cascade: boolean;
  /** Final tier that produced `predicted`: keyword | semantic | cascade. */
  stage: "keyword" | "semantic" | "cascade";
  /** Final pre-cascade confidence (of the winning tier). */
  margin: number;
  entropy: number;
  /** Per-tier confidence (always recorded, for offline threshold re-sweeping). */
  kwMargin: number;
  kwEntropy: number;
  semMargin: number;
  semEntropy: number;
  /** Final pre-cascade scores. */
  scores: Record<string, number>;
  /** Raw per-tier classifier distributions. */
  kwScores: Record<string, number>;
  semScores: Record<string, number>;
  /** Per-tier evidence (for future llm-as-judge). */
  kwEvidence: Record<string, string[]>;
  semEvidence: Record<string, string[]>;
  latencyMs: number;
  kwLatencyMs: number;
  semLatencyMs: number;
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