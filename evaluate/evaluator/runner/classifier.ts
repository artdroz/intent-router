/**
 * Classifier Evaluation Runner
 *
 * Runs a single classifier (keyword | semantic | llm) against one or more
 * datasets and splits, writing per-prompt JSONL to runs/{dataset}/classifier/.
 *
 * Prerequisite: datasets at evaluate/dataset/{name}/
 *   {name}.config.json          — gate config (classes, utterances, keywords)
 *   {name}.jsonl                — unsplit prompts
 *   {name}.val.jsonl            — validation split
 *   {name}.test.jsonl           — test split
 *
 * Usage:
 *   npx tsx evaluate/evaluator/runner/classifier.ts \
 *     --classifier semantic --dataset k8,nextjs --split val,test
 *
 *   --classifier       keyword | semantic | llm | all (required)
 *   --dataset          k8,nextjs,pythonc,vscode (comma-separated, required)
 *   --split            val,test (comma-separated, omit for unsplit dataset)
 *   --verbose          true | false
 *   --limit            max prompts per combo
 *   --embedding-url    embedding API base URL (semantic only)
 *   --embedding-model  embedding model name (default: nomic-embed-text)
 *   --llm-url          LLM API base URL (llm only, default: http://localhost:11434)
 *   --llm-model        LLM model name (default: qwen2.5:7b)
 *
 * Output: runs/{dataset}/classifier/{classifier}.{split}.jsonl
 *   { id, truth, predicted, correct, scores, latencyMs }
 */

import { KeywordClassifier } from "../../../src/routing/classifiers/keyword.js";
import { SemanticClassifier } from "../../../src/routing/classifiers/semantic.js";
import { LlmClassifier } from "../../../src/routing/classifiers/llm.js";
import { createEmbedClient } from "../../../src/lib/embed-client.js";
import { createLlmClient } from "../../../src/lib/llm-client.js";
import type { ClassificationResult } from "../../../src/routing/classifiers/types.js";
import {
  initDbAndSeed,
  loadConfig,
  loadDataset,
  buildGate,
  formatProbs,
  printPerClassSummary,
  parseBaseArgs,
  writeRun,
  type ClassifierPrompt,
} from "./shared.js";
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_URL,
  DEFAULT_LLM_URL,
  DEFAULT_LLM_MODEL,
} from "../config.js";

// ── Types ──

interface EvalResult {
  id: string;
  expected: string;
  predicted: string;
  correct: boolean;
  scores: Record<string, number>;
  evidence: Record<string, string[]>;
  durationMs: number;
}

// ── Main ──

async function main() {
  const raw = parseBaseArgs();

  if (!raw.classifier) {
    console.error("Error: --classifier is required (keyword | semantic | llm | all)");
    process.exit(1);
  }

  const classifiers = raw.classifier === "all"
    ? ["keyword", "semantic", "llm"]
    : [raw.classifier];
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
  const embeddingUrl = raw["embedding-url"] ?? DEFAULT_EMBEDDING_URL;
  const embeddingModel = raw["embedding-model"] ?? DEFAULT_EMBEDDING_MODEL;
  const llmUrl = raw["llm-url"] ?? DEFAULT_LLM_URL;
  const llmModel = raw["llm-model"] ?? DEFAULT_LLM_MODEL;

  // Seed all datasets (always index embeddings — needed by semantic)
  let embedFn: ((text: string) => Promise<number[]>) | undefined;
  for (const ds of datasets) {
    const config = loadConfig(ds);
    const ctx = await initDbAndSeed(config, {
      indexEmbeddings: true,
      embeddingUrl,
      embeddingModel,
    });
    if (ctx.embed) embedFn = ctx.embed;
  }

  // Evaluate each classifier × dataset × split combination
  const allResults: EvalResult[] = [];
  let lastRunPath = "";

  for (const classifierName of classifiers) {
    const classifier = buildClassifier(
      classifierName,
      { embeddingUrl, embeddingModel, llmUrl, llmModel },
      embedFn!,
    );

    for (const ds of datasets) {
      const config = loadConfig(ds);
      const gate = buildGate(config);

      for (const split of splits) {
        const rows = loadDataset(ds, split);

        console.log(
          `\nGate: ${gate.name}  |  Classifier: ${classifierName}  |  Split: ${split ?? "-"}  |  Prompts: ${rows.length}`,
        );
        console.log("─".repeat(80));

      const comboResults: EvalResult[] = [];
      for (const row of rows) {
        if (limit && comboResults.length >= limit) break;

        const t0 = performance.now();
        const cr = await classifier.classify(row.prompt, gate);
        const durationMs = Math.round(performance.now() - t0);
        const predicted = topLabel(cr);
        const correct = predicted === row.label;

        comboResults.push({
          id: row.id,
          expected: row.label,
          predicted,
          correct,
          scores: entriesToObj(cr.entries),
          evidence: evidenceToObj(cr.entries),
          durationMs,
        });

        printResult(comboResults[comboResults.length - 1], verbose);
      }

      allResults.push(...comboResults);

      // Write per-combo raw results
      const outSuffix = split ? `.${split}` : "";
      lastRunPath = writeRun(
        `${ds}/classifier/${classifierName}${outSuffix}.jsonl`,
        comboResults.map((r): ClassifierPrompt => ({
          id: r.id,
          truth: r.expected,
          predicted: r.predicted,
          correct: r.correct,
          scores: r.scores,
          latencyMs: r.durationMs,
        })),
      );
    }
  }
  } // end classifier loop

  printSummary(allResults, classifiers.length === 1 ? classifiers[0] : "all", lastRunPath);
}

// ── Classifier Construction ──

function buildClassifier(
  mode: string,
  args: {
    embeddingUrl?: string;
    embeddingModel?: string;
    llmUrl: string;
    llmModel: string;
  },
  embed?: (text: string) => Promise<number[]>,
) {
  if (mode === "keyword") {
    return new KeywordClassifier();
  }

  if (mode === "semantic") {
    const embedClient = embed
      ? { embed, dims: 0 }
      : createEmbedClient({
          baseUrl: args.embeddingUrl ?? DEFAULT_EMBEDDING_URL,
          model: args.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
        });
    return new SemanticClassifier(embedClient);
  }

  if (mode === "llm") {
    // createLlmClient appends "/v1/chat/completions", so strip any trailing "/v1".
    const baseUrl = args.llmUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    const client = createLlmClient({ baseUrl, model: args.llmModel });
    return new LlmClassifier(client);
  }

  throw new Error(`Unknown classifier: ${mode}`);
}

// ── Result Helpers ──

function topLabel(cr: ClassificationResult): string {
  let best = "";
  let max = -1;
  for (const [label, entry] of cr.entries) {
    if (entry.prob > max) {
      max = entry.prob;
      best = label;
    }
  }
  return best;
}

function entriesToObj(
  entries: ClassificationResult["entries"],
): Record<string, number> {
  const obj: Record<string, number> = {};
  for (const [label, entry] of entries) obj[label] = entry.prob;
  return obj;
}

function evidenceToObj(
  entries: ClassificationResult["entries"],
): Record<string, string[]> {
  const obj: Record<string, string[]> = {};
  for (const [label, entry] of entries) obj[label] = entry.evidence;
  return obj;
}

// ── Output ──

function printResult(r: EvalResult, verbose: boolean) {
  const mark = r.correct ? "✅" : "❌";
  const top1 = Math.max(...Object.values(r.scores), 0);
  console.log(
    `${mark} ${r.id}  expected=${r.expected}  predicted=${r.predicted}  top1=${top1.toFixed(3)}  (${r.durationMs}ms)`,
  );
  console.log(`   scores: ${formatProbs(r.scores)}`);
  if (verbose && r.evidence[r.predicted]?.length) {
    console.log(
      `   evidence: ${r.evidence[r.predicted].slice(0, 3).join(" | ")}`,
    );
  }
}

function printSummary(results: EvalResult[], classifierName: string, runPath: string) {
  const correct = results.filter((r) => r.correct).length;
  const accuracy = ((correct / results.length) * 100).toFixed(1);
  const avgMs = Math.round(
    results.reduce((s, r) => s + r.durationMs, 0) / results.length,
  );

  console.log("─".repeat(80));
  console.log(
    `Summary  |  ${classifierName}  |  Accuracy: ${accuracy}% (${correct}/${results.length})  |  Avg: ${avgMs}ms`,
  );
  printPerClassSummary(results);
  console.log(`\nRaw results → ${runPath}`);
}

// ── Entry ──

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
