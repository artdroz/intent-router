/**
 * Cascade Router Evaluation Runner (with LLM fallback)
 *
 * Runs the full cascading pipeline: keyword + semantic pre-classify, then
 * LLM fallback when the gatekeeper is uncertain.
 *
 * Prerequisite: flat datasets at evaluate/dataset/ as
 *   {dataset}-fnl-company-opus.{val,test}.jsonl  (dataset: k8, cpython, vscode)
 * with ground-truth labels in `adaptive_label` or `complexity_label`, plus the
 * shared taxonomy gate configs request_type.config.json / complexity_tier.config.json.
 *
 * Usage:
 *   npx tsx evaluate/evaluator/runner/router-with-learning.ts \
 *     --dataset k8,cpython --split val,test --label-field adaptive_label
 *
 *   --dataset         k8,cpython,vscode (comma-separated, required)
 *   --label-field     adaptive_label, complexity_label (comma-separated, default: adaptive_label)
 *   --split           val,test (comma-separated, omit for unsplit)
 *   --verbose         true | false
 *   --limit           max prompts per combo
 *   --kw-weight       keyword weight in aggregation (default: CAS_KW_WEIGHT = 0.3)
 *   --sem-weight      semantic weight in aggregation (default: CAS_SEM_WEIGHT = 0.7)
 *   --shuffle-seed    deterministic dataset shuffle seed (default: 20260901)
 *   --embedding-url   embedding API base URL
 *   --embedding-model embedding model name (default: nomic-embed-text)
 *   --llm-url         LLM API base URL (default: http://localhost:11434)
 *   --llm-model       LLM model name (default: qwen2.5:7b)
 *
 * Output: runs/{dataset}/{gate}/router/cascade-with-learning.{split}.jsonl
 *   { id, truth, predicted, correct, cascaded, preLatencyMs, llmLatencyMs, totalLatencyMs }
 */

import { randomUUID } from "node:crypto";
import { KeywordClassifier } from "../../../src/routing/classifiers/keyword.js";
import { SemanticClassifier } from "../../../src/routing/classifiers/semantic.js";
import { LlmClassifier } from "../../../src/routing/classifiers/llm.js";
import { CascadingRouter, resolvePrecascade } from "../../../src/routing/router/cascading.js";
import { computeMargin, computeEntropy } from "../../../src/routing/utils.js";
import type { ClassificationResult } from "../../../src/routing/classifiers/types.js";
import type { RouteResult } from "../../../src/routing/router/types.js";
import { initEmbedClient } from "../../../src/lib/embed-client.js";
import { initLlmClient } from "../../../src/lib/llm-client.js";
import {
  initRouter,
  submitFeedback as submitRouteFeedback,
  promoteKeyword as promoteRouteKeywords,
} from "../../../src/routing/service.js";
import { getGatesByTenant } from "../../../src/store/gates.js";
import { toGate } from "../../../src/gates/service.js";
import { insertRouteEvent } from "../../../src/store/routing.js";
import {
  initDbAndSeed,
  loadConfig,
  loadDataset,
  buildGate,
  makeEmbedClient,
  makeLlmClient,
  printPerClassSummary,
  parseBaseArgs,
  resolveLabelFields,
  writeRun,
  shuffleDataset,
  type RouterPrompt,
} from "./shared.js";
import {
  DEFAULT_EMBEDDING_URL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_LLM_URL,
  DEFAULT_LLM_MODEL,
  DEFAULT_SHUFFLE_SEED,
} from "../config.js";
import {
  CAS_KW_WEIGHT,
  CAS_SEM_WEIGHT,
} from "../../../src/routing/config.js";

import { main as cleanupDb } from "../eval-cleanup.js";

// ── Types ──

interface EvalResult {
  id: string;
  phase?: "train" | "eval";
  rollingAccuracy?: number;
  expected: string;
  predicted: string;
  correct: boolean;
  cascaded: boolean;
  preLatencyMs: number;
  llmLatencyMs: number;
  totalLatencyMs: number;
  margin?: number;
  entropy?: number;
}

// ── Main ──

async function main() {
  const raw = parseBaseArgs();
  const labelFields = resolveLabelFields(raw);

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
  const kwWeight = raw["kw-weight"] ? parseFloat(raw["kw-weight"]) : CAS_KW_WEIGHT;
  const semWeight = raw["sem-weight"] ? parseFloat(raw["sem-weight"]) : CAS_SEM_WEIGHT;
  const embeddingUrl = raw["embedding-url"] ?? DEFAULT_EMBEDDING_URL;
  const embeddingModel = raw["embedding-model"] ?? DEFAULT_EMBEDDING_MODEL;
  const llmUrl = raw["llm-url"] ?? DEFAULT_LLM_URL;
  const llmModel = raw["llm-model"] ?? DEFAULT_LLM_MODEL;
  const continuousLearning = raw["continuous-learning"] === "true" || raw["continuous-learning"] === "1";
  const feedbackEvery = raw["feedback-every"] ? Math.max(1, parseInt(raw["feedback-every"], 10)) : 1;
  const promoteEvery = raw["promote-every"] ? Math.max(1, parseInt(raw["promote-every"], 10)) : 10;
  const feedbackMode = raw["feedback-mode"] ?? "oracle";
  const trainSplitRatio = raw["train-split-ratio"] ? parseFloat(raw["train-split-ratio"]) : 0.8;
  const shuffleSeed = raw["shuffle-seed"]
    ? Number(raw["shuffle-seed"])
    : DEFAULT_SHUFFLE_SEED;
  if (!Number.isFinite(shuffleSeed)) {
    throw new Error(`--shuffle-seed must be a finite number, got: ${raw["shuffle-seed"]}`);
  }

  // Build classifiers + cascade router once (label-agnostic)
  const embedClient = makeEmbedClient(embeddingUrl, embeddingModel);
  const keyword = new KeywordClassifier();
  const semantic = new SemanticClassifier(embedClient);
  const llmClient = makeLlmClient(llmUrl, llmModel);
  const llm = new LlmClassifier(llmClient);

  // Shared singleton clients are required by service.submitFeedback() and
  // service.route() when they fetch the embed/LLM clients internally.
  initEmbedClient({
    baseUrl: embeddingUrl,
    model: embeddingModel,
    apiKey: process.env.EMBED_API_KEY,
    dims: Number(process.env.EMBED_DIMS ?? 768),
  });
  initLlmClient({
    baseUrl: llmUrl,
    model: llmModel,
    apiKey: process.env.LLM_API_KEY,
  });
  initRouter(llmClient, embedClient, 50000);

  const router = new CascadingRouter(keyword, semantic, llm, {
    kwWeight,
    semWeight,
  });

  console.log(
    `\nRouter: cascade  |  Datasets: ${datasets.join(", ")}  |  Splits: ${splits.map((s) => s ?? "-").join(", ")}`,
  );
  console.log(
    `KW weight: ${kwWeight}  |  SEM weight: ${semWeight}`,
  );
  console.log(`Dataset shuffle: enabled  |  seed=${shuffleSeed}`);

  if (continuousLearning) {
    console.log("\nContinuous learning mode enabled. Training and hold-out evaluation are isolated.");
    console.log(
      `CL config: feedbackEvery=${feedbackEvery}, promoteEvery=${promoteEvery}, feedbackMode=${feedbackMode}, trainSplitRatio=${trainSplitRatio}`,
    );
    console.log(
      "Note: negative feedback is best-effort; the project mainly learns via positive feedback and keyword promotion.",
    );
  }

  for (const labelField of labelFields) {
    console.log(`\nLabel field: ${labelField}`);

    // Seed once per label taxonomy (all datasets share the same gate config).
    const config = loadConfig(datasets[0], labelField);
    const ctx = await initDbAndSeed(config, {
      indexEmbeddings: true,
      embeddingUrl,
      embeddingModel,
    });
    const tenantId = ctx.tenantId;

    // Evaluate each dataset × split combination
    const allResults: EvalResult[] = [];

    for (const ds of datasets) {
      const config = loadConfig(ds, labelField);
      const gate = buildGate(config);

      for (const split of splits) {
        if (continuousLearning) {
          const rows = shuffleDataset(
            split ? loadDataset(ds, split, labelField) : loadDataset(ds, undefined, labelField),
            shuffleSeed,
          );
          const clResults = await runContinuousLearningLoop({
            rows,
            gate,
            tenantId,
            router,
            llm,
            kwWeight,
            semWeight,
            feedbackEvery,
            promoteEvery,
            feedbackMode,
            trainSplitRatio,
            verbose,
            limit,
          });
          allResults.push(...clResults);
          writeRun(
            `${ds}/${gate.name}/router/cl.${split ?? "train-eval"}.jsonl`,
            clResults.map(toRunRow),
          );
          continue;
        }

        const rows = shuffleDataset(loadDataset(ds, split, labelField), shuffleSeed);

        console.log(
          `\nGate: ${gate.name}  |  Router: cascade  |  Split: ${split ?? "-"}  |  Prompts: ${rows.length}`,
        );
        console.log("─".repeat(80));

        const comboResults: EvalResult[] = [];
        for (const row of rows) {
          if (limit && comboResults.length >= limit) break;

          // Phase 1: pre-cascade (keyword + semantic)
          const t0 = performance.now();
          const pre = await router.runPrecascade(row.prompt, gate, tenantId);
          const preLatencyMs = Math.round(performance.now() - t0);

          const decision = resolvePrecascade(pre.kwResult, pre.semResult, gate, kwWeight, semWeight);
          const wouldCascade = decision.cascade;

          let predicted: string;
          let llmLatencyMs = 0;

          if (!wouldCascade) {
            predicted = decision.label ?? pre.result.label;
          } else {
            // Phase 2: LLM fallback
            const t1 = performance.now();
            const llmResult = await llm.classify(row.prompt, gate, tenantId);
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
          `${ds}/${gate.name}/router/cascade-with-learning${outSuffix}.jsonl`,
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

    printSummary(
      allResults,
      continuousLearning
        ? "Summary  |  cascade (train+eval)"
        : "Summary  |  cascade",
    );
  }
}

async function runContinuousLearningLoop(args: {
  rows: Array<{ id: string; label: string; prompt: string }>;
  gate: ReturnType<typeof buildGate>;
  tenantId: string;
  router: CascadingRouter;
  llm: LlmClassifier;
  kwWeight: number;
  semWeight: number;
  feedbackEvery: number;
  promoteEvery: number;
  feedbackMode: string;
  trainSplitRatio: number;
  verbose: boolean;
  limit?: number;
}): Promise<EvalResult[]> {
  const {
    rows,
    gate,
    tenantId,
    router,
    llm,
    kwWeight,
    semWeight,
    feedbackEvery,
    promoteEvery,
    feedbackMode,
    trainSplitRatio,
    verbose,
    limit,
  } = args;
  const safeRatio = Number.isFinite(trainSplitRatio) ? Math.min(Math.max(trainSplitRatio, 0.1), 0.9) : 0.8;
  const splitIndex = Math.max(1, Math.floor(rows.length * safeRatio));
  const trainRows = rows.slice(0, splitIndex);
  const evalRows = rows.slice(splitIndex);

  if (trainRows.length === 0 || evalRows.length === 0) {
    throw new Error(
      `Continuous learning requires both train and eval rows. Dataset size=${rows.length}, ratio=${safeRatio}`,
    );
  }

  console.log(
    `\nCL train/eval split: train=${trainRows.length}, eval=${evalRows.length} (ratio=${safeRatio})`,
  );

  // Resolve the seeded gate (with real DB ids) so route events can be recorded
  // for feedback. The cascade decision uses each classifier's own confidence
  // gate (isConfident) plus the kw/sem blend weights, mirroring the service.
  const visibleGates = await getGatesByTenant(tenantId);
  const rawGate = visibleGates.find((g) => g.gate.name === gate.name);
  if (!rawGate) throw new Error(`Gate "${gate.name}" not found for eval tenant`);
  const domainGate = toGate(rawGate);
  const gateClasses = rawGate.classes;

  /** Route one prompt through the cascade, returning the true pre-cascade
   *  gatekeeper margin/entropy plus the recorded route event id. */
  const routeRow = async (prompt: string) => {
    const t0 = performance.now();
    const pre = await router.runPrecascade(prompt, domainGate, tenantId);
    const preLatencyMs = Math.round(performance.now() - t0);

    const preMargin = computeMargin(pre.sorted);
    const preEntropy = computeEntropy(pre.sorted);
    const decision = resolvePrecascade(pre.kwResult, pre.semResult, domainGate, kwWeight, semWeight);
    const wouldCascade = decision.cascade;

    let result: RouteResult;
    let llmLatencyMs = 0;
    if (!wouldCascade) {
      result = {
        label: decision.label ?? pre.result.label,
        score: decision.score,
        stage: "pre-cascade",
        scores: decision.scores,
        confScore: decision.confScore,
      };
    } else {
      const t1 = performance.now();
      const llmResult = await llm.classify(prompt, domainGate, tenantId);
      llmLatencyMs = Math.round(performance.now() - t1);
      const label = pickTop(llmResult);
      result = {
        label,
        score: llmResult.entries.get(label)?.prob ?? 0,
        stage: "llm",
        scores: Object.fromEntries(
          [...llmResult.entries].map(([l, e]) => [l, e.prob]),
        ),
        confScore: llmResult.confScore,
      };
    }

    const routeId = `r_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const predictedClass = gateClasses.find((c) => c.label === result.label);
    if (predictedClass) {
      await insertRouteEvent({
        routeId,
        tenantId,
        gateId: domainGate.id,
        prompt,
        predictedClassId: predictedClass.id,
        stage: result.stage,
        scores: result.scores,
        confScore: result.confScore,
        channel: "mcp",
      });
    }

    return {
      routeId,
      result,
      margin: preMargin,
      entropy: preEntropy,
      preLatencyMs,
      llmLatencyMs,
      totalLatencyMs: preLatencyMs + llmLatencyMs,
    };
  };

  let iteration = 0;
  let rollingCorrect = 0;
  let rollingTotal = 0;
  const trainingResults: EvalResult[] = [];

  for (const row of trainRows) {
    if (limit && trainingResults.length >= limit) break;

    iteration++;
    const { routeId, result, margin, entropy, preLatencyMs, llmLatencyMs, totalLatencyMs } = await routeRow(row.prompt);

    const predicted = result.label;
    const isCorrect = predicted === row.label;
    rollingTotal++;
    if (isCorrect) rollingCorrect++;

    const cascaded = result.stage === "llm";
    const rollingAccuracy = rollingCorrect / rollingTotal;

    trainingResults.push({
      id: row.id,
      phase: "train",
      rollingAccuracy: round4(rollingAccuracy),
      expected: row.label,
      predicted,
      correct: isCorrect,
      cascaded,
      preLatencyMs,
      llmLatencyMs,
      totalLatencyMs,
      margin,
      entropy,
    });

    printResult(trainingResults[trainingResults.length - 1], verbose);

    if (iteration % feedbackEvery === 0) {
      const positive = feedbackMode === "oracle" ? isCorrect : Boolean(isCorrect);
      console.log(`[CL] ${positive ? "positive" : "negative"} feedback for route ${routeId} (${row.id})`);

      await submitRouteFeedback({ routeId, positive }, tenantId).catch((err) => {
        console.warn(`[CL] feedback submit skipped for ${routeId}:`, err instanceof Error ? err.message : err);
      });
    }

    if (iteration % promoteEvery === 0) {
      try {
        await promoteRouteKeywords();
        console.log(`[CL] promoteKeyword() triggered after ${iteration} training rows`);
      } catch (err) {
        console.warn(
          `[CL] keyword promotion skipped after ${iteration} rows:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    console.log(
      `[CL] train rolling accuracy: ${(rollingAccuracy * 100).toFixed(1)}% (${rollingCorrect}/${rollingTotal}) | row=${row.id}`,
    );
  }

  const holdoutResults: EvalResult[] = [];
  for (const row of evalRows) {
    if (limit && holdoutResults.length >= limit) break;

    const { result, margin, entropy, preLatencyMs, llmLatencyMs, totalLatencyMs } = await routeRow(row.prompt);

    const correct = result.label === row.label;
    const cascaded = result.stage === "llm";

    holdoutResults.push({
      id: row.id,
      phase: "eval",
      expected: row.label,
      predicted: result.label,
      correct,
      cascaded,
      preLatencyMs,
      llmLatencyMs,
      totalLatencyMs,
      margin,
      entropy,
    });

    printResult(holdoutResults[holdoutResults.length - 1], verbose);
  }

  console.log("\nHold-out evaluation (no feedback / no promotion):");
  printSummary(holdoutResults);

  // Return train + holdout so the top-level summary reports average accuracy
  // across the whole learning + evaluation run, not just the hold-out split.
  return [...trainingResults, ...holdoutResults];
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

/** Round to 4 decimal places (keeps JSONL rolling accuracy compact). */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Serialize an EvalResult for the runs/ JSONL. `phase` (train|eval) follows
 * `id`, and `rollingAccuracy` is present only for training rows.
 */
function toRunRow(r: EvalResult): Record<string, unknown> {
  return {
    id: r.id,
    ...(r.phase ? { phase: r.phase } : {}),
    ...(r.rollingAccuracy !== undefined
      ? { rollingAccuracy: r.rollingAccuracy }
      : {}),
    truth: r.expected,
    predicted: r.predicted,
    correct: r.correct,
    cascaded: r.cascaded,
    preLatencyMs: r.preLatencyMs,
    llmLatencyMs: r.llmLatencyMs,
    totalLatencyMs: r.totalLatencyMs,
  };
}

// ── Output ──

function printResult(r: EvalResult, verbose: boolean) {
  const mark = r.correct ? "✅" : "❌";
  const cascadeFlag = r.cascaded ? " ⚡LLM" : "";
  const ms = verbose
    ? `  pre=${r.preLatencyMs}ms llm=${r.llmLatencyMs}ms`
    : `  (${r.totalLatencyMs}ms)`;
  const gatekeeper =
    r.margin !== undefined && r.entropy !== undefined
      ? `  margin=${r.margin.toFixed(3)} entropy=${r.entropy.toFixed(3)}`
      : "";
  console.log(
    `${mark} ${r.id}  expected=${r.expected}  predicted=${r.predicted}${cascadeFlag}${ms}${gatekeeper}`,
  );
}

function printSummary(results: EvalResult[], label: string = "Summary  |  cascade") {
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
    `${label}  |  Accuracy: ${accuracy}% (${correct}/${results.length})  |  Avg: ${avgMs}ms`,
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
