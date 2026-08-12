import type { LlmClient } from "../../lib/llm-client.js";
import type { Gate } from "../../gates/types.js";
import type { Classifier, ClassificationResult } from "./types.js";
import { buildResult } from "./utils.js";

export class LlmClassifier implements Classifier {
  readonly name = "llm" as const;

  constructor(private llmClient: LlmClient) {}

  async classify(prompt: string, gate: Gate): Promise<ClassificationResult> {
    const labels = gate.classes.map((c) => c.label);
    const isBinary = gate.classes.length === 1;
    const expectedLabels = isBinary ? [...labels, "none"] : labels;

    const answer = await this.llmClient.complete(
      [
        { role: "system", content: buildSystemPrompt(gate, isBinary) },
        { role: "user", content: prompt },
      ],
      { type: "json_schema", json_schema: buildSchema(expectedLabels) },
    );

    return parseResponse(answer, labels, isBinary);
  }
}

function buildSystemPrompt(gate: Gate, isBinary: boolean): string {
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
    isBinary
      ? `- Include "none" for non-match: {"distribution":{"${gate.classes[0].label}":0.0,"none":1.0}}`
      : "",
  ].join("\n");
}

function buildSchema(expectedLabels: string[]) {
  const properties: Record<string, { type: "number" }> = {};
  for (const label of expectedLabels) {
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
          required: expectedLabels,
          additionalProperties: false,
        },
      },
      required: ["reasoning", "distribution"],
      additionalProperties: false,
    },
  };
}

function parseResponse(
  raw: string,
  labels: string[],
  isBinary: boolean,
): ClassificationResult {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let parsed: { reasoning?: string; distribution?: Record<string, number> };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { classifier: "llm", entries: new Map() };
  }

  const dist = parsed.distribution;
  if (!dist || typeof dist !== "object") return { classifier: "llm", entries: new Map() };

  const expected = isBinary ? [...labels, "none"] : labels;

  const scores = new Map<string, number>();
  const evidence = new Map<string, string[]>();
  const reasonText = parsed.reasoning || "No reasoning provided.";

  for (const label of expected) {
    if (isBinary && label === "none") continue;
    const raw = Math.max(0, typeof dist[label] === "number" ? dist[label] : 0);
    scores.set(label, raw);
    evidence.set(label, [reasonText]);
  }

  return buildResult("llm", scores, evidence);
}
