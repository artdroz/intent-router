import type { Classifier, ClassificationResult } from "./types.js";
import type { EmbedClient } from "../../lib/embed-client.js";
import type { Gate } from "../../gates/types.js";
import {
  SEM_CONFIG_WEIGHT,
  SEM_FEEDBACK_WEIGHT,
  SEM_SIMILARITY_THRESHOLD,
  SEM_TOP_K,
} from "../config.js";
import { buildResult } from "../utils.js";
import { searchByGate } from "../../store/embeddings.js";
import type { SearchResult } from "../../store/embeddings.js";

export type SemanticOptions = {
  topK?: number;
  similarityThreshold?: number;
  configWeight?: number;
  feedbackWeight?: number;
};

export class SemanticClassifier implements Classifier {
  readonly name = "semantic" as const;

  private topK: number;
  private similarityThreshold: number;
  private configWeight: number;
  private feedbackWeight: number;

  constructor(
    private embedClient: EmbedClient,
    opts?: SemanticOptions,
  ) {
    this.topK = opts?.topK ?? SEM_TOP_K;
    this.similarityThreshold = opts?.similarityThreshold ?? SEM_SIMILARITY_THRESHOLD;
    this.configWeight = opts?.configWeight ?? SEM_CONFIG_WEIGHT;
    this.feedbackWeight = opts?.feedbackWeight ?? SEM_FEEDBACK_WEIGHT;
  }

  async classify(prompt: string, gate: Gate, tenantId: string): Promise<ClassificationResult> {
    const embedding = await this.embedClient.embed(prompt);
    const rows = await searchByGate(gate.name, tenantId, embedding, this.topK);

    // Explicit veto: a negative guardrail within the similarity threshold vetoes
    // its intent, removing it from the semantic distribution so the cascade falls
    // back to the 2nd-best intent or the LLM.
    const vetoed = detectVetoedLabels(rows, this.similarityThreshold);
    const scorable = vetoed.size > 0 ? rows.filter((r) => !vetoed.has(r.label)) : rows;

    return aggregateSemantic(
      scorable,
      this.similarityThreshold,
      this.configWeight,
      this.feedbackWeight,
    );
  }
}

/** Source tag for negative guardrail embeddings (explicit-veto evidence). */
const NEG_FEEDBACK_SOURCE = "neg_feedback";

/**
 * Return the set of intent labels vetoed by negative guardrails in the ANN
 * results. A guardrail fires only when its similarity (`1 - distance`) is at
 * or above the threshold — a distant guardrail must not veto anything.
 */
export function detectVetoedLabels(rows: SearchResult[], threshold: number): Set<string> {
  const vetoed = new Set<string>();
  for (const row of rows) {
    if (row.source === NEG_FEEDBACK_SOURCE && 1 - row.distance >= threshold) {
      vetoed.add(row.label);
    }
  }
  return vetoed;
}

/**
 * Aggregate global ANN results into per-class normalized probabilities.
 *
 * 1. Drop negative guardrails (they are veto evidence, never positive signal)
 * 2. Convert distance → similarity (1 - distance)
 * 3. Apply source multiplier: config utterances get 1.2× bonus
 * 4. Sum weighted similarities per class
 * 5. Normalize each sum by total → [0, 1]
 */
export function aggregateSemantic(
  rows: SearchResult[],
  similarityThreshold: number,
  configWeight: number,
  feedbackWeight: number,
): ClassificationResult {
  const scorable = rows.filter((r) => r.source !== NEG_FEEDBACK_SOURCE);

  const scores = new Map<string, number>();
  const evidence = new Map<string, string[]>();

  for (const row of scorable) {
    // pgvector `<=>` returns cosine DISTANCE (0 = identical, 2 = opposite).
    // Convert to similarity first, then apply the similarity threshold.
    const sim = 1 - row.distance;
    if (sim < similarityThreshold) continue;

    const multiplier = row.source === "config" ? configWeight : feedbackWeight;
    const weighted = sim * multiplier;
    scores.set(row.label, (scores.get(row.label) ?? 0) + weighted);

    const list = evidence.get(row.label) ?? [];
    list.push(row.content);
    evidence.set(row.label, list);
  }

  // If nothing cleared the similarity threshold, spread the probability over
  // all returned neighbours (weighted by similarity) instead of collapsing to
  // the single nearest neighbour, so the cascade gatekeeper sees honest
  // uncertainty rather than a false 100% confidence.
  if (scores.size === 0 && scorable.length > 0) {
    for (const row of scorable) {
      const sim = 1 - row.distance;
      const multiplier = row.source === "config" ? configWeight : feedbackWeight;
      const weighted = sim * multiplier;
      scores.set(row.label, (scores.get(row.label) ?? 0) + weighted);

      const list = evidence.get(row.label) ?? [];
      list.push(row.content);
      evidence.set(row.label, list);
    }
  }

  return { classifier: "semantic", entries: buildResult(scores, evidence) };
}
