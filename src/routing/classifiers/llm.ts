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

/** Escape a string so it can be embedded verbatim in a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
