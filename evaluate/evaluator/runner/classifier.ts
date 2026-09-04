/**
 * Classifier Evaluation Runner
 *
 * Runs a single classifier (keyword | semantic | llm) against one or more
 * datasets and splits for ONE label taxonomy (gate), writing per-prompt JSONL
 * to runs/{dataset}/{gate}/classifier/.
 *
 * Prerequisite: flat datasets at evaluate/dataset/ as
 *   {dataset}-fnl-company-opus.{val,test}.jsonl  (dataset: k8, cpython, vscode)
 * with ground-truth labels in `adaptive_label` or `complexity_label`, plus the
 * shared taxonomy gate configs request_type.config.json / complexity_tier.config.json.
 *
 * Usage:
 *   npx tsx evaluate/evaluator/runner/classifier.ts \
 *     --classifier semantic --dataset k8,cpython --split val,test \
 *     --label-field adaptive_label
 *
 *   --classifier       keyword | semantic | llm | all (required)
 *   --dataset          k8,cpython,vscode (comma-separated, required)
 *   --label-field      adaptive_label, complexity_label (comma-separated, default: adaptive_label)
 *   --split            val,test (comma-separated, omit for unsplit dataset)
 *   --verbose          true | false
 *   --limit            max prompts per combo
 *   --embedding-url    embedding API base URL (semantic only)
 *   --embedding-model  embedding model name (default: nomic-embed-text)
 *   --llm-url          LLM API base URL (llm only, default: http://localhost:11434)
 *   --llm-model        LLM model name (default: qwen2.5:7b)
 *
 * Output: runs/{dataset}/{gate}/classifier/{classifier}.{split}.jsonl
 *   { id, truth, predicted, correct, scores, latencyMs }
 */

import { KeywordClassifier } from "../../../src/routing/classifiers/keyword.js";
import { SemanticClassifier } from "../../../src/routing/classifiers/semantic.js";
import { LlmClassifier } from "../../../src/routing/classifiers/llm.js";
import type { ClassificationResult } from "../../../src/routing/classifiers/types.js";
import {
  initDbAndSeed,
  loadConfig,
  loadDataset,
  buildGate,
  formatProbs,
  makeEmbedClient,
  makeLlmClient,
  printPerClassSummary,
  parseBaseArgs,
  resolveLabelFields,
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
  confScore: number;
  isConfident: boolean;
  durationMs: number;
}

// ── Main ──

async function main() {
  const raw = parseBaseArgs();
  const labelFields = resolveLabelFields(raw);

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

  let lastRunPath = "";

  for (const labelField of labelFields) {
    console.log(`\nLabel field: ${labelField}`);

    // Seed once per label taxonomy — all datasets share the same gate config
    // for this taxonomy, so a single seed indexes the shared gate + embeddings.
    // Always index embeddings — needed by semantic.
    const config = loadConfig(datasets[0], labelField);
    const ctx = await initDbAndSeed(config, {
      indexEmbeddings: true,
      embeddingUrl,
      embeddingModel,
    });
    const tenantId = ctx.tenantId;
    const embedFn = ctx.embed;

    // Evaluate each classifier × dataset × split combination
    const allResults: EvalResult[] = [];

    for (const classifierName of classifiers) {
      const classifier = buildClassifier(
        classifierName,
        { embeddingUrl, embeddingModel, llmUrl, llmModel },
        embedFn!,
      );

      for (const ds of datasets) {
        const config = loadConfig(ds, labelField);
        const gate = buildGate(config);

        for (const split of splits) {
          const rows = loadDataset(ds, split, labelField);

          console.log(
            `\nGate: ${gate.name}  |  Classifier: ${classifierName}  |  Split: ${split ?? "-"}  |  Prompts: ${rows.length}`,
          );
          console.log("─".repeat(80));

          const comboResults: EvalResult[] = [];
          for (const row of rows) {
            if (limit && comboResults.length >= limit) break;

            const t0 = performance.now();
            const cr = await classifier.classify(row.prompt, gate, tenantId);
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
              confScore: cr.confScore,
              isConfident: cr.isConfident,
              durationMs,
            });

            printResult(comboResults[comboResults.length - 1], verbose);
          }

          allResults.push(...comboResults);

          // Write per-combo raw results
          const outSuffix = split ? `.${split}` : "";
          lastRunPath = writeRun(
            `${ds}/${gate.name}/classifier/${classifierName}${outSuffix}.jsonl`,
            comboResults.map((r): ClassifierPrompt => ({
              id: r.id,
              truth: r.expected,
              predicted: r.predicted,
              correct: r.correct,
              scores: r.scores,
              confScore: r.confScore,
              isConfident: r.isConfident,
              latencyMs: r.durationMs,
            })),
          );
        }
      }
    }

    printSummary(allResults, classifiers.length === 1 ? classifiers[0] : "all", lastRunPath);
  }
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
      : makeEmbedClient(
          args.embeddingUrl ?? DEFAULT_EMBEDDING_URL,
          args.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
        );
    return new SemanticClassifier(embedClient);
  }

  if (mode === "llm") {
    const client = makeLlmClient(args.llmUrl, args.llmModel);
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
