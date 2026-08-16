/**
 * Cascade Router Evaluation Runner (with LLM fallback)
 *
 * Runs the full cascading pipeline: keyword + semantic pre-classify, then
 * LLM fallback when the gatekeeper is uncertain.
 *
 * Prerequisite: datasets at evaluate/dataset/{name}/
 *   {name}.config.json          — gate config (classes, utterances, keywords)
 *   {name}.jsonl                — unsplit prompts
 *   {name}.val.jsonl            — validation split
 *   {name}.test.jsonl           — test split
 *
 * Usage:
 *   npx tsx evaluate/evaluator/runner/router.ts --dataset k8,nextjs --split val,test
 *
 *   --dataset         k8,nextjs,pythonc,vscode (comma-separated, required)
 *   --split           val,test (comma-separated, omit for unsplit)
 *   --verbose         true | false
 *   --limit           max prompts per combo
 *   --margin          margin threshold (default: 0.3)
 *   --entropy         entropy threshold (default: 1.3)
 *   --kw-weight       keyword weight in aggregation (default: 0.3)
 *   --sem-weight      semantic weight in aggregation (default: 0.7)
 *   --embedding-url   embedding API base URL
 *   --embedding-model embedding model name (default: nomic-embed-text)
 *   --llm-url         LLM API base URL (default: http://localhost:11434)
 *   --llm-model       LLM model name (default: qwen2.5:7b)
 *
 * Output: runs/{dataset}/router/cascade.{split}.jsonl
 *   { id, truth, predicted, correct, cascaded, preLatencyMs, llmLatencyMs, totalLatencyMs }
 */

import { KeywordClassifier } from "../../../src/routing/classifiers/keyword.js";
import { SemanticClassifier } from "../../../src/routing/classifiers/semantic.js";
import { LlmClassifier } from "../../../src/routing/classifiers/llm.js";
import { CascadingRouter, shouldCascade } from "../../../src/routing/router/cascading.js";
import { createLlmClient } from "../../../src/lib/llm-client.js";
import type { ClassificationResult } from "../../../src/routing/classifiers/types.js";
import { createEmbedClient } from "../../../src/lib/embed-client.js";
import {
  initDbAndSeed,
  loadConfig,
  loadDataset,
  buildGate,
  printPerClassSummary,
  parseBaseArgs,
  writeRun,
  type RouterPrompt,
} from "./shared.js";
import {
  DEFAULT_EMBEDDING_URL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_LLM_URL,
  DEFAULT_LLM_MODEL,
  DEFAULT_MARGIN_THRESHOLD,
  DEFAULT_ENTROPY_THRESHOLD,
  DEFAULT_KW_WEIGHT,
  DEFAULT_SEM_WEIGHT,
} from "../config.js";

// ── Types ──

interface EvalResult {
  id: string;
  expected: string;
  predicted: string;
  correct: boolean;
  cascaded: boolean;
  preLatencyMs: number;
  llmLatencyMs: number;
  totalLatencyMs: number;
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
  const entropy = raw["entropy"]
    ? parseFloat(raw["entropy"])
    : DEFAULT_ENTROPY_THRESHOLD;
  const embeddingUrl = raw["embedding-url"] ?? DEFAULT_EMBEDDING_URL;
  const embeddingModel = raw["embedding-model"] ?? DEFAULT_EMBEDDING_MODEL;
  const llmUrl = raw["llm-url"] ?? DEFAULT_LLM_URL;
  const llmModel = raw["llm-model"] ?? DEFAULT_LLM_MODEL;

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

  // Build classifiers + cascade router (shared across datasets)
  const keyword = new KeywordClassifier();
  const semantic = new SemanticClassifier(embedClient);
  const llmClient = createLlmClient({
    baseUrl: llmUrl.replace(/\/v1\/?$/, "").replace(/\/$/, ""),
    model: llmModel,
  });
  const llm = new LlmClassifier(llmClient);

  const router = new CascadingRouter(keyword, semantic, llm, {
    marginThreshold: margin,
    kwWeight,
    semWeight,
    entropyThreshold: entropy,
  });

  console.log(
    `\nRouter: cascade  |  Datasets: ${datasets.join(", ")}  |  Splits: ${splits.map((s) => s ?? "-").join(", ")}`,
  );
  console.log(
    `Margin: ${margin}  |  Entropy: ${entropy}  |  KW weight: ${kwWeight}  |  SEM weight: ${semWeight}`,
  );

  // Evaluate each dataset × split combination
  const allResults: EvalResult[] = [];

  for (const ds of datasets) {
    const config = loadConfig(ds);
    const gate = buildGate(config);

    for (const split of splits) {
      const rows = loadDataset(ds, split);

      console.log(
        `\nGate: ${gate.name}  |  Router: cascade  |  Split: ${split ?? "-"}  |  Prompts: ${rows.length}`,
      );
      console.log("─".repeat(80));

      const comboResults: EvalResult[] = [];
      for (const row of rows) {
        if (limit && comboResults.length >= limit) break;

        // Phase 1: pre-cascade (keyword + semantic)
        const t0 = performance.now();
        const pre = await router.runPrecascade(row.prompt, gate);
        const preLatencyMs = Math.round(performance.now() - t0);

        const wouldCascade = shouldCascade(pre.margin, pre.entropy, margin, entropy);

        let predicted: string;
        let llmLatencyMs = 0;

        if (!wouldCascade) {
          predicted = pre.result.label;
        } else {
          // Phase 2: LLM fallback
          const t1 = performance.now();
          const llmResult = await llm.classify(row.prompt, gate);
          llmLatencyMs = Math.round(performance.now() - t1);
          predicted = pickTop(llmResult);
        }

        const totalLatencyMs = preLatencyMs + llmLatencyMs;
        const correct = predicted === row.label;

        comboResults.push({
          id: row.id,
          expected: row.label,
          predicted,
          correct,
          cascaded: wouldCascade,
          preLatencyMs,
          llmLatencyMs,
          totalLatencyMs,
        });

        printResult(comboResults[comboResults.length - 1], verbose);
      }

      allResults.push(...comboResults);

      // Write per-combo raw results
      const outSuffix = split ? `.${split}` : "";
      writeRun(
        `${ds}/router/cascade${outSuffix}.jsonl`,
        comboResults.map((r): RouterPrompt => ({
          id: r.id,
          truth: r.expected,
          predicted: r.predicted,
          correct: r.correct,
          cascaded: r.cascaded,
          preLatencyMs: r.preLatencyMs,
          llmLatencyMs: r.llmLatencyMs,
          totalLatencyMs: r.totalLatencyMs,
        })),
      );
    }
  }

  printSummary(allResults);
}

// ── Helpers ──

function pickTop(result: ClassificationResult): string {
  let bestLabel = "";
  let bestScore = 0;
  for (const [label, entry] of result.entries) {
    if (entry.prob > bestScore) {
      bestScore = entry.prob;
      bestLabel = label;
    }
  }
  return bestLabel;
}

// ── Output ──

function printResult(r: EvalResult, verbose: boolean) {
  const mark = r.correct ? "✅" : "❌";
  const cascadeFlag = r.cascaded ? " ⚡LLM" : "";
  const ms = verbose
    ? `  pre=${r.preLatencyMs}ms llm=${r.llmLatencyMs}ms`
    : `  (${r.totalLatencyMs}ms)`;
  console.log(
    `${mark} ${r.id}  expected=${r.expected}  predicted=${r.predicted}${cascadeFlag}${ms}`,
  );
}

function printSummary(results: EvalResult[]) {
  const correct = results.filter((r) => r.correct).length;
  const accuracy = ((correct / results.length) * 100).toFixed(1);
  const avgMs = Math.round(
    results.reduce((s, r) => s + r.totalLatencyMs, 0) / results.length,
  );

  // Cascade stats
  const cascaded = results.filter((r) => r.cascaded);
  const cascadeRate = ((cascaded.length / results.length) * 100).toFixed(1);

  // LLM conditional accuracy
  const llmCorrect = cascaded.filter((r) => r.correct).length;
  const llmAccuracy =
    cascaded.length > 0
      ? ((llmCorrect / cascaded.length) * 100).toFixed(1)
      : "N/A";

  // Average latency breakdown
  const avgPreMs = Math.round(
    results.reduce((s, r) => s + r.preLatencyMs, 0) / results.length,
  );
  const avgLlmMs =
    cascaded.length > 0
      ? Math.round(
          cascaded.reduce((s, r) => s + r.llmLatencyMs, 0) / cascaded.length,
        )
      : 0;

  console.log("─".repeat(80));
  console.log(
    `Summary  |  cascade  |  Accuracy: ${accuracy}% (${correct}/${results.length})  |  Avg: ${avgMs}ms`,
  );
  console.log(
    `Cascade rate: ${cascadeRate}% (${cascaded.length}/${results.length})  |  LLM accuracy: ${llmAccuracy}% (${llmCorrect}/${cascaded.length})`,
  );
  console.log(
    `Latency  |  Avg pre: ${avgPreMs}ms  |  Avg LLM (when called): ${avgLlmMs}ms`,
  );
  printPerClassSummary(results);
}

// ── Entry ──

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
