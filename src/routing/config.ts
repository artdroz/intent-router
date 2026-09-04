// Keyword classifier
export const KW_CONFIG_WEIGHT = 2.0;
export const KW_FEEDBACK_WEIGHT = 1.0;

// Semantic classifier
export const SEM_TOP_K = 20;
export const SEM_SIMILARITY_THRESHOLD = 0.25;
export const SEM_CONFIG_WEIGHT = 2.0;
export const SEM_FEEDBACK_WEIGHT = 1.0;

// Cascade classifier
export const CAS_KW_WEIGHT = 0.3;
export const CAS_SEM_WEIGHT = 0.7;
export const CAS_MARGIN_THRESHOLD = 0.54;
/** Entropy is normalized to [0, 1] (see computeEntropy). */
export const CAS_ENTROPY_THRESHOLD = 0.78;

// Keyword learning (TF-IDF)
/** Maximum number of keywords promoted per class (prevent from skewing the configured keywords). */
export const LRN_MAX_PER_CLASS = 30;
/** Skip keyword promotion until this many feedback rows have accumulated. */
export const LRN_MIN_FEEDBACK_ROWS = 20;
/** Minimum precision (pos / (pos + neg)) for a keyword to be promoted. */
export const LRN_PRECISION_FLOOR = 0.6;
/** How often a keyword must appear in a class and how class-unspecific must be considered for promotion. */
export const LRN_SCORE_THRESHOLD = 0.1;

// Semantic learning (embedding-based)
export const LRN_MIN_VOTES = 2;
export const LRN_SEM_VETO_THRESHOLD = 0.5;
export const LRN_SEM_VETO_MARGIN = 0;
export const LRN_NEG_MARGIN = 0.2;

/** Function words removed before keyword extraction/matching (learning noise filter). */
export const STOPWORDS = new Set([
  "a", "an", "the", "this", "that", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "to", "of", "in", "on", "at", "by", "for", "with", "without", "about", "into", "from",
  "and", "or", "not", "but", "if", "then", "else", "as", "so", "than",
  "do", "does", "did", "can", "could", "should", "would", "will", "shall", "may", "might",
  "how", "what", "when", "where", "which", "who", "why",
  "i", "me", "my", "we", "us", "our", "you", "your", "he", "she", "his", "her", "it", "its", "they", "them", "their",
  "there", "here", "no", "yes", "ok", "please", "just", "also", "only", "up", "down",
]);

/** Maximum LLM attempts before giving up on a usable answer. */
export const LLM_MAX_ATTEMPTS = 3;
