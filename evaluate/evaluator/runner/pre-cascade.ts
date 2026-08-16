/**
 * Pre-cascade Evaluation Runner — keyword + semantic aggregation only, no LLM.
 *
 * Evaluates the gatekeeper in isolation: for each prompt, computes the
 * aggregated score and decides whether it would cascade to LLM.
 *
 * Prerequisite: datasets at evaluate/dataset/{name}/
 *   {name}.config.json          — gate config (classes, utterances, keywords)
 *   {name}.jsonl                — unsplit prompts
 *   {name}.val.jsonl            — validation split
 *   {name}.test.jsonl           — test split
 *
 * Usage:
 *   npx tsx evaluate/evaluator/runner/pre-cascade.ts --dataset k8,nextjs --split val,test
 *
 *   --dataset           k8,nextjs,pythonc,vscode (comma-separated, required)
 *   --split             val,test (comma-separated, omit for unsplit)
 *   --verbose           true | false
 *   --limit             max prompts per combo
 *   --margin            margin threshold (default: 0.3)
 *   --entropy-threshold entropy threshold (default: 1.3)
 *   --kw-weight         keyword weight in aggregation (default: 0.3)
 *   --sem-weight        semantic weight in aggregation (default: 0.7)
 *   --embedding-url     embedding API base URL
 *   --embedding-model   embedding model name (default: nomic-embed-text)
 *
 * Output: runs/{dataset}/pre-cascade/m{margin}_H{entropy}_kw{kw}_sem{sem}.{split}.jsonl
 *   { id, truth, predicted, correct, margin, entropy, cascade, scores, latencyMs }
 */
import { KeywordClassifier } from "../../../src/routing/classifiers/keyword.js";
import { SemanticClassifier } from "../../../src/routing/classifiers/semantic.js";
import { CascadingRouter, shouldCascade } from "../../../src/routing/router/cascading.js";
import { createEmbedClient } from "../../../src/lib/embed-client.js";

import {
  initDbAndSeed,
  loadConfig,
  loadDataset,
  buildGate,
  formatProbs,
  printPerClassSummary,
  parseBaseArgs,
  writeRun,
  type PreCascadePrompt,
} from "./shared.js";
import {
  DEFAULT_EMBEDDING_URL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_MARGIN_THRESHOLD,
  DEFAULT_ENTROPY_THRESHOLD,
  DEFAULT_KW_WEIGHT,
  DEFAULT_SEM_WEIGHT,
} from "../config.js";

// ── Types ──

interface PreEvalResult {
  id: string;
  truth: string;
  predicted: string;
  correct: boolean;
  margin: number;
  entropy: number;
  wouldCascade: boolean;
  scores: Record<string, number>;
  durationMs: number;
}

// ── Main ──

async function main() {
  const raw = parseBaseArgs();

  if (!raw.dataset) {
    console.error("Error: --dataset is required (comma-separated for multiple)");
    process.exit(1);
  }

  const datasets = raw.dataset.split(",").map((s) => s.trim()).filter(Boolean);
  const splits = raw.split
    ? raw.split.split(",").map((s) => s.trim()).filter(Boolean)
    : [undefined];

  const verbose = raw.verbose === "true";
  const limit = raw.limit ? parseInt(raw.limit, 10) : undefined;
  const margin = raw.margin ? parseFloat(raw.margin) : DEFAULT_MARGIN_THRESHOLD;
  const kwWeight = raw["kw-weight"] ? parseFloat(raw["kw-weight"]) : DEFAULT_KW_WEIGHT;
  const semWeight = raw["sem-weight"] ? parseFloat(raw["sem-weight"]) : DEFAULT_SEM_WEIGHT;
  const entropyThreshold = raw["entropy-threshold"]
    ? parseFloat(raw["entropy-threshold"])
    : DEFAULT_ENTROPY_THRESHOLD;
  const embeddingUrl = raw["embedding-url"] ?? DEFAULT_EMBEDDING_URL;
  const embeddingModel = raw["embedding-model"] ?? DEFAULT_EMBEDDING_MODEL;

  // Seed all datasets
  const embedClient = createEmbedClient({ baseUrl: embeddingUrl, model: embeddingModel });
  for (const ds of datasets) {
    const config = loadConfig(ds);
    const ctx = await initDbAndSeed(config, {
      indexEmbeddings: true,
      embeddingUrl,
      embeddingModel,
    });
  }

  // Build classifiers + router (LLM classifier not needed for pre-classify)
  const keyword = new KeywordClassifier();
  const semantic = new SemanticClassifier(embedClient);

  const dummyLlm = {
    name: "llm" as const,
    classify: async () => {
      throw new Error("LLM should not be called");
    },
  };
  const router = new CascadingRouter(keyword, semantic, dummyLlm as any, {
    marginThreshold: margin,
    kwWeight,
    semWeight,
    entropyThreshold,
  });

  console.log(
    `\npre-cascade (no LLM)  |  Datasets: ${datasets.join(", ")}  |  Splits: ${splits.map((s) => s ?? "-").join(", ")}`,
  );
  console.log(
    `Margin: ${margin}  |  Entropy: ${entropyThreshold}  |  KW: ${kwWeight}  |  SEM: ${semWeight}`,
  );

  // Evaluate each dataset × split combination
  const allResults: PreEvalResult[] = [];

  for (const ds of datasets) {
    const config = loadConfig(ds);
    const gate = buildGate(config);

    for (const split of splits) {
      const rows = loadDataset(ds, split);

      console.log(
        `\nGate: ${gate.name}  |  pre-cascade (no LLM)  |  Split: ${split ?? "-"}  |  Prompts: ${rows.length}`,
      );
      console.log("─".repeat(80));

      const comboResults: PreEvalResult[] = [];
      for (const row of rows) {
        if (limit && comboResults.length >= limit) break;

        const t0 = performance.now();
        const pre = await router.runPrecascade(row.prompt, gate);
        const durationMs = Math.round(performance.now() - t0);
        const wouldCascade = shouldCascade(pre.margin, pre.entropy, margin, entropyThreshold);
        const correct = pre.result.label === row.label;

        comboResults.push({
          id: row.id,
          truth: row.label,
          predicted: pre.result.label,
          correct,
          margin: pre.margin,
          entropy: pre.entropy,
          wouldCascade: wouldCascade,
          scores: pre.result.scores,
          durationMs,
        });

        printResult(comboResults[comboResults.length - 1], verbose);
      }

      allResults.push(...comboResults);

      // Write per-combo raw results
      const paramTag = `m${margin}_H${entropyThreshold}_kw${kwWeight}_sem${semWeight}`;
      const splitSuffix = split ? `.${split}` : "";
      writeRun(
        `${ds}/pre-cascade/${paramTag}${splitSuffix}.jsonl`,
        comboResults.map((r): PreCascadePrompt => ({
          id: r.id,
          truth: r.truth,
          predicted: r.predicted,
          correct: r.correct,
          margin: r.margin,
          entropy: r.entropy,
          cascade: r.wouldCascade,
          scores: r.scores,
          latencyMs: r.durationMs,
        })),
      );
    }
  }

  printSummary(allResults);
}

// ── Output ──

function printResult(r: PreEvalResult, verbose: boolean) {
  const mark = r.correct ? "✅" : "❌";
  const cascadeFlag = r.wouldCascade ? " ⚡CASCADE" : "";
  console.log(
    `${mark} ${r.id}  truth=${r.truth}  predicted=${r.predicted}  margin=${r.margin.toFixed(3)}  H=${r.entropy.toFixed(3)}${cascadeFlag}  (${r.durationMs}ms)`,
  );
  if (verbose) {
    console.log(`   scores: ${formatProbs(r.scores)}`);
  }
}

function printSummary(results: PreEvalResult[]) {
  const correct = results.filter((r) => r.correct).length;
  const accuracy = ((correct / results.length) * 100).toFixed(1);
  const avgMs = Math.round(
    results.reduce((s, r) => s + r.durationMs, 0) / results.length,
  );

  // Cascade stats
  const cascadeCount = results.filter((r) => r.wouldCascade).length;
  const cascadeRate = ((cascadeCount / results.length) * 100).toFixed(1);
  const correctButCascade = results.filter(
    (r) => r.correct && r.wouldCascade,
  ).length;
  const wrongNoCascade = results.filter(
    (r) => !r.correct && !r.wouldCascade,
  ).length;

  // Margin + entropy distribution
  const margins = results.map((r) => r.margin).sort((a, b) => a - b);
  const p50 = margins[Math.floor(margins.length * 0.5)];
  const p90 = margins[Math.floor(margins.length * 0.9)];
  const entropies = results.map((r) => r.entropy).sort((a, b) => a - b);
  const hP50 = entropies[Math.floor(entropies.length * 0.5)];
  const hP90 = entropies[Math.floor(entropies.length * 0.9)];

  console.log("─".repeat(80));
  console.log(
    `Summary  |  pre-cascade  |  Accuracy: ${accuracy}% (${correct}/${results.length})  |  Avg: ${avgMs}ms`,
  );
  console.log(
    `Cascade rate: ${cascadeRate}% (${cascadeCount}/${results.length})  |  Margin P50=${p50.toFixed(3)} P90=${p90.toFixed(3)}  |  Entropy P50=${hP50.toFixed(3)} P90=${hP90.toFixed(3)}`,
  );
  console.log(
    `Correct but would cascade: ${correctButCascade}  |  Wrong but confident: ${wrongNoCascade}`,
  );
  printPerClassSummary(results);
}

// ── Entry ──

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
