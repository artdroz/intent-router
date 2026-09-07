import type { Gate } from "../../gates/types.js";

/** The decision returned by the cascading router. */
export type RouteResult = {
  /** Predicted intent label. */
  label: string;
  /** Probability of the predicted label (0–1). */
  score: number;
  /** Cascade stage that produced the decision. */
  stage: "pre-cascade" | "llm" | "historical";
  /** Per-class score distribution of the deciding stage. */
  scores: Record<string, number>;
};

export interface Router {
  readonly name: string;
  route(prompt: string, gate: Gate, tenantId: string): Promise<RouteResult>;
}

/** Tunable weights and thresholds for the cascade, with defaults in `routing/config.ts`. */
export type CascadeOptions = {
  kwWeight?: number;
  semWeight?: number;
  marginThreshold?: number;
  entropyThreshold?: number;
};

/** Provider for a last-resort class label based on routing history. */
export type HistoricalFallback = (gate: Gate, tenantId: string) => Promise<string | null>;
