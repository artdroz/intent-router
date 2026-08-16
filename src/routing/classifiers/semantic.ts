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

  async classify(prompt: string, gate: Gate): Promise<ClassificationResult> {
    const embedding = await this.embedClient.embed(prompt);
    const rows = await searchByGate(gate.name, embedding, this.topK);
    return aggregateSemantic(
      rows,
      this.similarityThreshold,
      this.configWeight,
      this.feedbackWeight,
    );
  }
}

/**
   * Aggregate global ANN results into per-class normalized probabilities.
   *
   * 1. Convert distance → similarity (1 - distance)
   * 2. Apply source multiplier: config utterances get 1.2× bonus
   * 3. Sum weighted similarities per class
   * 4. Normalize each sum by total → [0, 1]
   */
export function aggregateSemantic(
  rows: SearchResult[],
  similarityThreshold: number,
  configWeight: number,
  feedbackWeight: number,
): ClassificationResult {
  const scores = new Map<string, number>();
  const evidence = new Map<string, string[]>();

  for (const row of rows) {
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

  // TODO: Rethink about how to handle empty distribution
  // If nothing cleared the similarity threshold, fall back to the single
  // nearest neighbor so the classifier never returns an empty distribution.
  if (scores.size === 0 && rows.length > 0) {
    const nearest = rows[0];
    scores.set(nearest.label, 1 - nearest.distance);
    evidence.set(nearest.label, [nearest.content]);
  }

  return { classifier: "semantic", entries: buildResult(scores, evidence) };
}
