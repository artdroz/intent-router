import type { Classifier, ClassificationResult } from "./types.js";
import type { EmbedClient } from "../../lib/embed-client.js";
import type { Gate } from "../../gates/types.js";
import { SEM_CONFIG_WEIGHT, SEM_FEEDBACK_WEIGHT, SEM_SIMILARITY_THRESHOLD, SEM_TOP_K } from "../config.js";
import { buildResult } from "./utils.js";
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

  constructor(private embedClient: EmbedClient, opts?: SemanticOptions) {

    this.topK = opts?.topK ?? SEM_TOP_K;
    this.similarityThreshold = opts?.similarityThreshold ?? SEM_SIMILARITY_THRESHOLD;
    this.configWeight = opts?.configWeight ?? SEM_CONFIG_WEIGHT;
    this.feedbackWeight = opts?.feedbackWeight ?? SEM_FEEDBACK_WEIGHT;
  }

  async classify(prompt: string, gate: Gate): Promise<ClassificationResult> {
    const embedding = await this.embedClient.embed(prompt);
    const rows = await searchByGate(gate.name, embedding, this.topK);
    return this.aggregate(rows);
  }

  /**
   * Aggregate global ANN results into per-label normalized scores.
   *
   * 1. Convert distance → similarity (1 - distance)
   * 2. Apply source multiplier: config utterances get 1.2× bonus
   * 3. Sum weighted similarities per label
   * 4. Normalize each sum by total → [0, 1]
   */
  private aggregate(rows: SearchResult[]): ClassificationResult {
    const sums = new Map<string, number>();
    const evidence = new Map<string, string[]>();

    for (const row of rows) {
      if (row.distance < this.similarityThreshold) {
        continue;
      }
      const multiplier = row.source === "config" ? this.configWeight : this.feedbackWeight;
      const sim = (1 - row.distance) * multiplier;
      sums.set(row.label, (sums.get(row.label) ?? 0) + sim);

      const list = evidence.get(row.label) ?? [];
      list.push(row.content);
      evidence.set(row.label, list);
    }

    return buildResult("semantic", sums, evidence);
  }
}