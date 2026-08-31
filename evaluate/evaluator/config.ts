// Load .env so the evaluator defaults mirror the real service configuration
// (DATABASE_URL, EMBED_BASE_URL, EMBED_MODEL, EMBED_DIMS, EMBED_API_KEY,
//  LLM_BASE_URL, LLM_MODEL, LLM_API_KEY).
try {
  process.loadEnvFile?.();
} catch {
  // No .env file — fall back to the hardcoded dev defaults below.
}

/** Root directory for raw evaluation run output (JSONL). */
export const RUNS_DIR = "evaluate/runs";

/** Root directory for computed metrics (JSON). */
export const METRICS_DIR = "evaluate/metrics";

// ── Service env (matches src/app.ts env schema and .env) ──

export const DATABASE_URL = process.env.DATABASE_URL;

// Embedding
export const EMBED_BASE_URL =
  process.env.EMBED_BASE_URL ?? "http://localhost:11434";
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";
export const EMBED_DIMS = process.env.EMBED_DIMS
  ? Number(process.env.EMBED_DIMS)
  : undefined;
export const EMBED_API_KEY = process.env.EMBED_API_KEY;

// LLM
export const LLM_BASE_URL =
  process.env.LLM_BASE_URL ?? "http://localhost:11434";
export const LLM_MODEL = process.env.LLM_MODEL ?? "qwen2.5:7b";
export const LLM_API_KEY = process.env.LLM_API_KEY;

// ── Retry / rate limiting (company endpoint) ──

export const RETRY_DELAY_MS = process.env.RETRY_DELAY_MS
  ? Number(process.env.RETRY_DELAY_MS)
  : 5000;

/** Minimum gap between outbound embed/LLM requests (avoids 429/403). */
export const REQUEST_INTERVAL_MS = process.env.REQUEST_INTERVAL_MS
  ? Number(process.env.REQUEST_INTERVAL_MS)
  : 500;

// ── Runner CLI defaults (backward-compatible aliases) ──

export const DEFAULT_EMBEDDING_URL = EMBED_BASE_URL;
export const DEFAULT_EMBEDDING_MODEL = EMBED_MODEL;
export const DEFAULT_LLM_URL = LLM_BASE_URL;
export const DEFAULT_LLM_MODEL = LLM_MODEL;

// ── Cascade / Pre-cascade defaults ──

export const DEFAULT_MARGIN_THRESHOLD = 0.3;
export const DEFAULT_ENTROPY_THRESHOLD = 0.8;
export const DEFAULT_KW_WEIGHT = 0.3;
export const DEFAULT_SEM_WEIGHT = 0.7;

// ── Threshold tuning defaults ──

export const DEFAULT_W_ERROR = 1.0;
export const DEFAULT_W_DOUBT = 2.0;
export const DEFAULT_SWEEP_MARGIN_MIN = 0;
export const DEFAULT_SWEEP_MARGIN_MAX = 1.0;
export const DEFAULT_SWEEP_ENTROPY_MIN = 0;
export const DEFAULT_SWEEP_ENTROPY_MAX = 1.0;
export const DEFAULT_SWEEP_STEP = 0.05;
export const DEFAULT_SWEEP_TOP = 15;
