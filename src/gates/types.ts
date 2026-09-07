/**
 * Per-gate configuration.
 *
 * `learningEnabled` gates the READ side of online learning only: when false,
 * the cheap classifiers ignore promoted keywords and learned embeddings/guardrails
 * (see KeywordClassifier and SemanticClassifier). Feedback ingestion and the
 * keyword-promotion cron are intentionally NOT gated here, so a gate that is
 * later re-enabled resumes from the evidence gathered while it was off.
 */
export type GateConfig = {
  learningEnabled: boolean;
};

/** One intent within a gate, carrying the anchors the classifiers consume. */
export type GateClass = {
  id: number;
  label: string;
  description?: string;
  utterances: string[];
  keywords: string[];
};

/** A routing taxonomy: a named set of intents (classes) scoped to a tenant. */
export type Gate = {
  id: number;
  tenantId: string | null;
  name: string;
  description: string | null;
  config: GateConfig;
  classes: GateClass[];
  createdAt: Date;
  updatedAt: Date;
};

/** Public shape of a class returned by the API; the database key is kept internal. */
export type GateClassDto = {
  label: string;
  description?: string;
  utterances: string[];
  keywords: string[];
};

/** Public shape of a gate returned by the API; database keys stay internal. */
export type GateDto = {
  name: string;
  description: string | null;
  shared: boolean;
  config: GateConfig;
  classes: GateClassDto[];
  createdAt: Date;
  updatedAt: Date;
};
