import type { Gate } from "../../gates/types.js";

export type RouteResult = {
  label: string;
  score: number;
  stage: "pre-cascade" | "llm" | "historical";
  scores: Record<string, number>;
};

export interface Router {
  readonly name: string;
  route(prompt: string, gate: Gate, tenantId: string): Promise<RouteResult>;
}

export type CascadeOptions = {
  kwWeight?: number;
  semWeight?: number;
  marginThreshold?: number;
  entropyThreshold?: number;
};

/** Provider for a last-resort class label based on routing history. */
export type HistoricalFallback = (gate: Gate, tenantId: string) => Promise<string | null>;