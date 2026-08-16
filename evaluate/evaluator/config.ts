/** Root directory for raw evaluation run output (JSONL). */
export const RUNS_DIR = "evaluate/runs";

/** Root directory for computed metrics (JSON). */
export const METRICS_DIR = "evaluate/metrics";

// ── Embedding defaults ──

export const DEFAULT_EMBEDDING_URL = "http://localhost:11434";
export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";

// ── LLM defaults ──

export const DEFAULT_LLM_URL = "http://localhost:11434";
export const DEFAULT_LLM_MODEL = "qwen2.5:7b";

// ── Cascade / Pre-cascade defaults ──

export const DEFAULT_MARGIN_THRESHOLD = 0.3;
export const DEFAULT_ENTROPY_THRESHOLD = 1.3;
export const DEFAULT_KW_WEIGHT = 0.3;
export const DEFAULT_SEM_WEIGHT = 0.7;

// ── Threshold tuning defaults ──

export const DEFAULT_W_ERROR = 1.0;
export const DEFAULT_W_DOUBT = 2.0;
export const DEFAULT_SWEEP_MARGIN_MIN = 0;
export const DEFAULT_SWEEP_MARGIN_MAX = 1.0;
export const DEFAULT_SWEEP_ENTROPY_MIN = 0;
export const DEFAULT_SWEEP_ENTROPY_MAX = 3.0;
export const DEFAULT_SWEEP_STEP = 0.05;
export const DEFAULT_SWEEP_TOP = 15;
