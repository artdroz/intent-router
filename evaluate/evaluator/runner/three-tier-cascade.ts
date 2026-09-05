/**
 * Three-Tier Cascade Evaluation Runner — keyword → semantic → (would-LLM),
 * with NO LLM call.  Inspects the pre-cascade result of a sequential cascade.
 *
 * Unlike `pre-cascade.ts` (which blends keyword + semantic in parallel), this
 * runner simulates a *sequential* three-tier gatekeeper:
 *
 *   Tier 1: keyword classifier   — if confident, stop (stage: keyword)
 *   Tier 2: semantic classifier  — if confident, stop (stage: semantic)
 *   Tier 3: would defer to LLM   — recorded as `cascade: true` (stage: cascade)
 *
 * Both classifiers are ALWAYS run (so per-tier margins/entropies and scores are
 * recorded for offline threshold re-sweeping and future llm-as-judge evidence),
 * but the final decision follows the sequential policy above.
 *
 * Usage:
 *   npx tsx evaluate/evaluator/runner/three-tier-cascade.ts \
 *     --dataset k8,cpython,vscode --split val,test --label-field adaptive_label
 *
 *   --dataset           k8,cpython,vscode (comma-separated, required)
 *   --label-field       adaptive_label | complexity_label (default: adaptive_label)
 *   --split             val,test (comma-separated, omit for unsplit)
 *   --verbose           true | false
 *   --limit             max prompts per combo
 *   --margin            margin threshold (default: 0.54)
 *   --entropy-threshold entropy threshold (default: 0.78, normalized 0–1)
 *   --embedding-url     embedding API base URL
 *   --embedding-model   embedding model name (default: nomic-embed-text)
 *
 * Output: runs/{dataset}/{gate}/three-tier/m{margin}_H{entropy}.{split}.jsonl
 *   where {gate} is the taxonomy gate name (request_type or complexity_tier),
 *   e.g. runs/vscode/request_type/three-tier/m0.54_H0.78.val.jsonl
 *   { id, truth, predicted, correct, cascade, stage, margin, entropy,
 *     kwMargin, kwEntropy, semMargin, semEntropy, scores, kwScores, semScores,
 *     kwEvidence, semEvidence, latencyMs, kwLatencyMs, semLatencyMs }
 *
 * Metrics: `npx tsx evaluate/evaluator/compute-metrics.ts --stage three-tier ...`
 */
import { KeywordClassifier } from "../../../src/routing/classifiers/keyword.js";
import { SemanticClassifier } from "../../../src/routing/classifiers/semantic.js";
import { computeRelativeMargin, computeEntropy } from "../../../src/routing/utils.js";
import type {
  ClassificationEntry,
  ClassificationResult,
} from "../../../src/routing/classifiers/types.js";
import type { Gate } from "../../../src/gates/types.js";

import {
  initDbAndSeed,
  loadConfig,
  loadDataset,
  buildGate,
  makeEmbedClient,
  printPerClassSummary,
  parseBaseArgs,
  resolveLabelField,
  writeRun,
  type ThreeTierPrompt,
} from "./shared.js";
import {
  DEFAULT_EMBEDDING_URL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_MARGIN_THRESHOLD,
  DEFAULT_ENTROPY_THRESHOLD,
} from "../config.js";

// ── Helpers ──

/** Fill in any gate classes missing from a single-classifier distribution. */
function ensureAllClasses(
  entries: Map<string, ClassificationEntry>,
  gate: Gate,
): Map<string, ClassificationEntry> {
  const complete = new Map(entries);
  for (const c of gate.classes) {
    if (!complete.has(c.label)) complete.set(c.label, { prob: 0, evidence: [] });
  }
  return complete;
}

function entriesToScores(entries: Map<string, ClassificationEntry>): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const [label, e] of entries) scores[label] = e.prob;
  return scores;
}

function entriesToEvidence(entries: Map<string, ClassificationEntry>): Record<string, string[]> {
  const evidence: Record<string, string[]> = {};
  for (const [label, e] of entries) evidence[label] = e.evidence;
  return evidence;
}

function sortEntries(entries: Map<string, ClassificationEntry>): [string, ClassificationEntry][] {
  return [...entries.entries()].sort((a, b) => b[1].prob - a[1].prob);
}

// ── Main ──

async function main() {
  const raw = parseBaseArgs();
  const labelField = resolveLabelField(raw);

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
  const entropyThreshold = raw["entropy-threshold"]
    ? parseFloat(raw["entropy-threshold"])
    : DEFAULT_ENTROPY_THRESHOLD;
  const embeddingUrl = raw["embedding-url"] ?? DEFAULT_EMBEDDING_URL;
  const embeddingModel = raw["embedding-model"] ?? DEFAULT_EMBEDDING_MODEL;

  // All datasets share one taxonomy config per label field (e.g. request_type),
  // so a single seed indexes the shared gate + utterance embeddings.
  const seedConfig = loadConfig(datasets[0], labelField);
  const ctx = await initDbAndSeed(seedConfig, {
    indexEmbeddings: true,
    embeddingUrl,
    embeddingModel,
  });
  const tenantId = ctx.tenantId;

  const embedClient = makeEmbedClient(embeddingUrl, embeddingModel);
  const keyword = new KeywordClassifier();
  const semantic = new SemanticClassifier(embedClient);

  console.log(
    `\nthree-tier cascade (no LLM)  |  Datasets: ${datasets.join(", ")}  |  Splits: ${splits.map((s) => s ?? "-").join(", ")}`,
  );
  console.log(`Margin: ${margin}  |  Entropy: ${entropyThreshold}  |  keyword → semantic → (LLM)`);

  const allResults: ThreeTierPrompt[] = [];

  for (const ds of datasets) {
    const config = loadConfig(ds, labelField);
    const gate = buildGate(config);

    for (const split of splits) {
      const rows = loadDataset(ds, split, labelField);

      console.log(
        `\nGate: ${gate.name}  |  three-tier (no LLM)  |  Split: ${split ?? "-"}  |  Prompts: ${rows.length}`,
      );
      console.log("─".repeat(80));

      const comboResults: ThreeTierPrompt[] = [];
      for (const row of rows) {
        if (limit && comboResults.length >= limit) break;

        const kwT0 = performance.now();
        const kwResult: ClassificationResult = await keyword.classify(row.prompt, gate, tenantId);
        const kwLatencyMs = Math.round(performance.now() - kwT0);

        const semT0 = performance.now();
        const semResult: ClassificationResult = await semantic.classify(row.prompt, gate, tenantId);
        const semLatencyMs = Math.round(performance.now() - semT0);

        const kwEntries = ensureAllClasses(kwResult.entries, gate);
        const semEntries = ensureAllClasses(semResult.entries, gate);

        const sortedKw = sortEntries(kwEntries);
        const sortedSem = sortEntries(semEntries);

        const kwMargin = computeRelativeMargin(sortedKw);
        const kwEntropy = computeEntropy(sortedKw);
        const semMargin = computeRelativeMargin(sortedSem);
        const semEntropy = computeEntropy(sortedSem);

        const kwConfident = kwMargin >= margin && kwEntropy <= entropyThreshold;
        const semConfident = semMargin >= margin && semEntropy <= entropyThreshold;

        let stage: ThreeTierPrompt["stage"];
        let predicted: string;
        let finalMargin: number;
        let finalEntropy: number;
        let cascade = false;

        if (kwConfident) {
          stage = "keyword";
          predicted = sortedKw[0][0];
          finalMargin = kwMargin;
          finalEntropy = kwEntropy;
        } else if (semConfident) {
          stage = "semantic";
          predicted = sortedSem[0][0];
          finalMargin = semMargin;
          finalEntropy = semEntropy;
        } else {
          stage = "cascade";
          cascade = true;
          // Best pre-cascade guess available before deferring to the LLM.
          predicted = sortedSem[0][0];
          finalMargin = semMargin;
          finalEntropy = semEntropy;
        }

        const finalEntries = stage === "keyword" ? kwEntries : semEntries;
        const latencyMs = stage === "keyword" ? kwLatencyMs : kwLatencyMs + semLatencyMs;

        const record: ThreeTierPrompt = {
          id: row.id,
          truth: row.label,
          predicted,
          correct: predicted === row.label,
          cascade,
          stage,
          margin: finalMargin,
          entropy: finalEntropy,
          kwMargin,
          kwEntropy,
          semMargin,
          semEntropy,
          scores: entriesToScores(finalEntries),
          kwScores: entriesToScores(kwEntries),
          semScores: entriesToScores(semEntries),
          kwEvidence: entriesToEvidence(kwEntries),
          semEvidence: entriesToEvidence(semEntries),
          latencyMs,
          kwLatencyMs,
          semLatencyMs,
        };

        comboResults.push(record);
        printResult(record, verbose);
      }

      allResults.push(...comboResults);

      const paramTag = `m${margin}_H${entropyThreshold}`;
      const splitSuffix = split ? `.${split}` : "";
      const outPath = writeRun(
        `${ds}/${gate.name}/three-tier/${paramTag}${splitSuffix}.jsonl`,
        comboResults,
      );
      console.log(`Run → ${outPath}`);
    }
  }

  printSummary(allResults);
}

// ── Output ──

function printResult(r: ThreeTierPrompt, verbose: boolean) {
  const mark = r.correct ? "✅" : "❌";
  const cascadeFlag = r.cascade ? " ⚡→LLM" : "";
  const tier = r.stage === "keyword" ? "KW" : r.stage === "semantic" ? "SEM" : "LLM";
  console.log(
    `${mark} ${r.id}  [${tier}]  truth=${r.truth}  predicted=${r.predicted}  margin=${r.margin.toFixed(3)}  H=${r.entropy.toFixed(3)}${cascadeFlag}  (${r.latencyMs}ms)`,
  );
  if (verbose) {
    console.log(`   kw : margin=${r.kwMargin.toFixed(3)} H=${r.kwEntropy.toFixed(3)}  scores: ${formatScores(r.kwScores)}`);
    console.log(`   sem: margin=${r.semMargin.toFixed(3)} H=${r.semEntropy.toFixed(3)}  scores: ${formatScores(r.semScores)}`);
  }
}

function formatScores(scores: Record<string, number>): string {
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([label, prob]) => `${label}=${prob.toFixed(3)}`)
    .join("  ");
}

function printSummary(results: ThreeTierPrompt[]) {
  const total = results.length;
  if (total === 0) return;

  const correct = results.filter((r) => r.correct).length;
  const accuracy = ((correct / total) * 100).toFixed(1);

  const cascadeCount = results.filter((r) => r.cascade).length;
  const cascadeRate = ((cascadeCount / total) * 100).toFixed(1);

  const silentErrors = results.filter((r) => !r.correct && !r.cascade).length;
  const silentErrorRate = ((silentErrors / total) * 100).toFixed(1);

  const correctButCascade = results.filter((r) => r.correct && r.cascade).length;
  const regretCascadeRate = ((correctButCascade / total) * 100).toFixed(1);

  const kwCount = results.filter((r) => r.stage === "keyword").length;
  const semCount = results.filter((r) => r.stage === "semantic").length;
  const kwRate = ((kwCount / total) * 100).toFixed(1);
  const semRate = ((semCount / total) * 100).toFixed(1);

  const avgMs = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / total);

  console.log("─".repeat(80));
  console.log(
    `Summary  |  three-tier  |  Accuracy: ${accuracy}% (${correct}/${total})  |  Avg: ${avgMs}ms`,
  );
  console.log(
    `Cascade (→LLM) rate: ${cascadeRate}% (${cascadeCount}/${total})  |  Keyword tier: ${kwRate}%  |  Semantic tier: ${semRate}%`,
  );
  console.log(
    `Silent errors (wrong, not cascaded): ${silentErrors} (${silentErrorRate}%)  |  Regret cascades (correct, cascaded): ${correctButCascade} (${regretCascadeRate}%)`,
  );
  printPerClassSummary(results);
}

// ── Entry ──

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
