// Keyword classifier
export const KW_CONFIG_WEIGHT = 1.2;
export const KW_FEEDBACK_WEIGHT = 1.0;

// Semantic classifier
export const SEM_TOP_K = 10;
export const SEM_SIMILARITY_THRESHOLD = 0.7;
export const SEM_CONFIG_WEIGHT = 1.2;
export const SEM_FEEDBACK_WEIGHT = 1.0;

// Cascade classifier
export const CAS_KW_WEIGHT = 0.3;
export const CAS_SEM_WEIGHT = 0.7;
export const CAS_MARGIN_THRESHOLD = 0.15;
export const CAS_ENTROPY_THRESHOLD = 1.2;
export const CAS_KEYWORD_GATE_BOOST = 1.5;  // TODO: Need tuning

// Keyword learning (TF-IDF)
export const LRN_SCORE_THRESHOLD = 0.05;
export const LRN_MAX_PER_CLASS = 30;
