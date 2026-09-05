import type { LlmClient } from "../../lib/llm-client.js";
import type { Gate } from "../../gates/types.js";
import type { Classifier, ClassificationResult } from "./types.js";
import { buildResult } from "../utils.js";

export class LlmClassifier implements Classifier {
  readonly name = "llm" as const;

  constructor(private llmClient: LlmClient) {}

  async classify(prompt: string, gate: Gate, _tenantId: string): Promise<ClassificationResult> {
    const labels = gate.classes.map((c) => c.label);

    const answer = await this.llmClient.complete(
      [
        { role: "system", content: buildSystemPrompt(gate) },
        { role: "user", content: prompt },
      ],
      buildSchema(labels),
    );

    const { scores, evidence } = parseResponse(answer, labels);
    return { classifier: "llm", entries: buildResult(scores, evidence) };
  }
}

/**
 * Regex-only variant: asks the model to reply with the bare label name.
 * No JSON is requested — the router recovers the label with a regex scan.
 */
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
    "Output ONLY the label name. No JSON, no markdown, no explanation, no other text.",
    "",
    "Rules:",
    "- Choose EXACTLY ONE label from the list above that best matches the task.",
    "- Reply with ONLY that label and nothing else.",
  ].join("\n");
}

export function buildJsonSchema(labels: string[]) {
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
 *
 * Primary path: parse the structured `{reasoning, distribution}` JSON. If the
 * model emits something that is not a parseable distribution (free text, a
 * stray tier string, etc.), fall back to a brute-force regex that ignores the
 * JSON structure entirely and grabs the first label appearing as a standalone
 * word, assigning it a score of 1.0.
 */
export function parseJsonResponse(
  raw: string,
  labels: string[],
): { scores: Map<string, number>; evidence: Map<string, string[]> } {
  // Strip markdown code fences the model sometimes wraps the JSON in.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: { reasoning?: string; distribution?: Record<string, number> } | undefined;
  try {
    parsed = JSON.parse(cleaned) as { reasoning?: string; distribution?: Record<string, number> };
  } catch {
    parsed = undefined;
  }

  const dist = parsed?.distribution;
  if (dist && typeof dist === "object") {
    const scores = new Map<string, number>();
    const evidence = new Map<string, string[]>();
    // One shared reasoning sentence becomes the evidence for every label.
    const reasonText = parsed?.reasoning || "No reasoning provided.";

    for (const label of labels) {
      // Clamp negatives to 0 and treat missing/non-numeric values as 0.
      const score = Math.max(0, typeof dist[label] === "number" ? dist[label] : 0);
      scores.set(label, score);
      evidence.set(label, [reasonText]);
    }

    return { scores, evidence };
  }

  // --- Regex fallback: ignore JSON structure and scan for label words. ---
  const scores = new Map<string, number>();
  const evidence = new Map<string, string[]>();

  const pattern = new RegExp(`\\b(?:${labels.map(escapeRegExp).join("|")})\\b`, "i");
  const match = raw.match(pattern);

  if (match) {
    const matched = labels.find((label) => label.toLowerCase() === match[0].toLowerCase());
    if (matched) {
      const reasonText = `Matched label "${matched}" via regex fallback.`;
      for (const label of labels) {
        scores.set(label, label === matched ? 1 : 0);
        evidence.set(label, [reasonText]);
      }
    }
  }

  return { scores, evidence };
}

/** Escape a string so it can be embedded verbatim in a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex-only variant: no structured output is requested, so there is no
 * schema. Kept for API symmetry — passing the result as the response format
 * simply disables it (`undefined`).
 */
export function buildSchema(_labels: string[]): undefined {
  return undefined;
}

/**
 * Regex-only parse: skip JSON entirely and grab the first label appearing as
 * a standalone word in the raw answer. The matched label gets 1.0; every
 * other label gets 0.
 */
export function parseResponse(
  raw: string,
  labels: string[],
): { scores: Map<string, number>; evidence: Map<string, string[]> } {
  const scores = new Map<string, number>();
  const evidence = new Map<string, string[]>();

  for (const label of labels) {
    scores.set(label, 0);
    evidence.set(label, []);
  }

  const pattern = new RegExp(`\\b(?:${labels.map(escapeRegExp).join("|")})\\b`, "i");
  const match = raw.match(pattern);

  if (match) {
    const matched = labels.find((label) => label.toLowerCase() === match[0].toLowerCase());
    if (matched) scores.set(matched, 1);
  }

  return { scores, evidence };
}
