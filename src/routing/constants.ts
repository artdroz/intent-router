/**
 * Tuning constants for the routing pipeline.
 *
 * Each constant is documented with its default and the trade-off it controls.
 * The cascade thresholds are swept on a validation set (see evaluate/) and
 * re-applied here as the hand-tuned defaults.
 */

// Keyword classifier

/** Weight of a configured (operator-authored) keyword in the keyword classifier. */
export const KW_CONFIG_WEIGHT = 2.0;
/** Weight of a promoted (learned) keyword in the keyword classifier. */
export const KW_FEEDBACK_WEIGHT = 1.0;

// Semantic classifier

/** Number of nearest neighbours the semantic classifier retrieves per query. */
export const SEM_TOP_K = 20;
/** Minimum cosine similarity (`1 - distance`) for a neighbour to be scored. */
export const SEM_SIMILARITY_THRESHOLD = 0.25;
/** Weight of a configured utterance embedding in the semantic classifier. */
export const SEM_CONFIG_WEIGHT = 2.0;
/** Weight of a learned feedback embedding in the semantic classifier. */
export const SEM_FEEDBACK_WEIGHT = 1.0;

// Cascade classifier

/** Pre-cascade blend weight of the keyword classifier (semantic gets the rest). */
export const CAS_KW_WEIGHT = 0.3;
/** Pre-cascade blend weight of the semantic classifier. */
export const CAS_SEM_WEIGHT = 0.7;
/** Minimum relative top-1/top-2 margin before the cascade escalates to the LLM. */
export const CAS_MARGIN_THRESHOLD = 0.54;
/** Maximum normalized entropy (see `computeEntropy`) before the cascade escalates. */
export const CAS_ENTROPY_THRESHOLD = 0.78;

// Keyword learning (TF-IDF)

/** Maximum number of keywords promoted per class (bounds learned influence). */
export const LRN_MAX_PER_CLASS = 30;
/** Minimum feedback rows before keyword promotion runs for a (tenant, gate) pair. */
export const LRN_MIN_FEEDBACK_ROWS = 20;
/** Minimum precision (`pos / (pos + neg)`) for a keyword to be promoted. */
export const LRN_PRECISION_FLOOR = 0.6;
/** Minimum TF-IDF score for a keyword to be promoted. */
export const LRN_SCORE_THRESHOLD = 0.1;

// Semantic learning (embedding-based)

/** Minimum guardrail votes required to veto a class. */
export const LRN_MIN_VOTES = 2;
/** Minimum similarity for a negative guardrail to fire. */
export const LRN_SEM_VETO_THRESHOLD = 0.5;
/** Minimum margin by which a guardrail must beat the class's best positive embedding. */
export const LRN_SEM_VETO_MARGIN = 0;
/** Minimum top-2 margin to learn from negative feedback (rejects noisy errors). */
export const LRN_NEG_MARGIN = 0.2;

/**
 * Tolerance for float subtraction in the `LRN_NEG_MARGIN` comparison (e.g.
 * 0.6 - 0.4 can land a hair below the threshold); keeps the gate inclusive.
 */
export const MARGIN_EPSILON = 1e-9;

/** Function words removed before keyword extraction/matching (learning noise filter). */
export const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "without",
  "about",
  "into",
  "from",
  "and",
  "or",
  "not",
  "but",
  "if",
  "then",
  "else",
  "as",
  "so",
  "than",
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "how",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "he",
  "she",
  "his",
  "her",
  "it",
  "its",
  "they",
  "them",
  "their",
  "there",
  "here",
  "no",
  "yes",
  "ok",
  "please",
  "just",
  "also",
  "only",
  "up",
  "down",
]);

/** Maximum LLM attempts before giving up on a usable answer. */
export const LLM_MAX_ATTEMPTS = 3;
