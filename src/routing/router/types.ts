import type { Gate } from "../../gates/types.js";

export type RouteResult = {
  label: string;
  score: number;
  stage: "pre-cascade" | "llm";
  scores: Record<string, number>;
};

export interface Router {
  readonly name: string;
  route(prompt: string, gate: Gate): Promise<RouteResult>;
}
