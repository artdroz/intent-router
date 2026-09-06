/**
 * Per-gate configuration.
 *
 * `learningEnabled` gates the READ side of online learning only: when false,
 * the cheap classifiers ignore promoted keywords and learnt embeddings/guardrails
 * (see KeywordClassifier and SemanticClassifier). Feedback ingestion and the
 * keyword-promotion cron are intentionally NOT gated here, so a gate that is
 * later re-enabled resumes from the evidence gathered while it was off.
 */
export type GateConfig = {
  learningEnabled: boolean;
};

export type GateClass = {
  id: number;
  label: string;
  description?: string;
  utterances: string[];
  keywords: string[];
};

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
