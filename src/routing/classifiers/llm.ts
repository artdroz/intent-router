import type { LlmClient } from "../../lib/llm-client.js";
import type { Gate } from "../../gates/types.js";
import type { Classifier, ClassificationResult } from "./types.js";
import { buildResult } from "../utils.js";

export class LlmClassifier implements Classifier {
  readonly name = "llm" as const;

  constructor(private llmClient: LlmClient) {}

  async classify(prompt: string, gate: Gate): Promise<ClassificationResult> {
    const labels = gate.classes.map((c) => c.label);

    const answer = await this.llmClient.complete(
      [
        { role: "system", content: buildSystemPrompt(gate) },
        { role: "user", content: prompt },
      ],
      { type: "json_schema", json_schema: buildSchema(labels) },
    );

    const { scores, evidence } = parseResponse(answer, labels);
    return { classifier: "llm", entries: buildResult(scores, evidence) };
  }
}

export function buildSystemPrompt(gate: Gate): string {
  const labelDescriptions = gate.classes
    .map((c) => `- "${c.label}": ${c.description ?? "No description"}`)
    .join("\n");

  return [
    gate.description
      ? `You are a task classifier. ${gate.description}`
      : "You are a task classifier.",
    "",
    "Labels:",
    labelDescriptions,
    "",
    "Output ONLY a JSON object. No markdown, no explanation, no other text:",
    '{"reasoning":"<one sentence>","distribution":{"label1":0.5,"label2":0.3,...}}',
    "",
    "Rules:",
    "- EVERY label MUST appear in distribution.",
    "- All values MUST sum to exactly 1.0.",
    "- Output ONLY the JSON object, nothing else.",
  ].join("\n");
}

export function buildSchema(labels: string[]) {
  const properties: Record<string, { type: "number" }> = {};
  for (const label of labels) {
    properties[label] = { type: "number" };
  }

  return {
    name: "classify_distribution",
    strict: true as const,
    schema: {
      type: "object" as const,
      properties: {
        reasoning: { type: "string" as const },
        distribution: {
          type: "object" as const,
          properties,
          required: labels,
          additionalProperties: false,
        },
      },
      required: ["reasoning", "distribution"],
      additionalProperties: false,
    },
  };
}

/**
 * Parse the LLM's JSON answer into raw per-label scores and evidence.
 */
export function parseResponse(
  raw: string,
  labels: string[],
): { scores: Map<string, number>; evidence: Map<string, string[]> } {
  // Strip markdown code fences the model sometimes wraps the JSON in.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: { reasoning?: string; distribution?: Record<string, number> };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { scores: new Map(), evidence: new Map() };
  }

  const dist = parsed.distribution;
  if (!dist || typeof dist !== "object") return { scores: new Map(), evidence: new Map() };

  const scores = new Map<string, number>();
  const evidence = new Map<string, string[]>();
  // One shared reasoning sentence becomes the evidence for every label.
  const reasonText = parsed.reasoning || "No reasoning provided.";

  for (const label of labels) {
    // Clamp negatives to 0 and treat missing/non-numeric values as 0.
    const score = Math.max(0, typeof dist[label] === "number" ? dist[label] : 0);
    scores.set(label, score);
    evidence.set(label, [reasonText]);
  }

  return { scores, evidence };
}
