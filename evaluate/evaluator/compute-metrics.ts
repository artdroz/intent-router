/**
 * Compute-metrics — reads raw JSONL from runs/{dataset}/{gate}/ and produces
 * per-dataset summary JSON in metrics/{stage}/{dataset}/{gate}/.
 *
 * Prerequisite: runs/{dataset}/{gate}/{stage}/*.jsonl must exist (run the
 *   corresponding evaluation runner first, with the same --label-field).
 *
 * Usage:
 *   npx tsx evaluate/evaluator/compute-metrics.ts --stage classifier --dataset k8,cpython
 *   npx tsx evaluate/evaluator/compute-metrics.ts --stage router --dataset k8,cpython --split val
 *   npx tsx evaluate/evaluator/compute-metrics.ts --stage all --dataset k8,cpython,vscode \
 *     --split val,test --label-field adaptive_label
 *
 *   --stage       classifier | pre-cascade | three-tier | router | all (required)
 *   --dataset     k8,cpython,vscode (comma-separated, required)
 *   --label-field adaptive_label,complexity_label (comma-separated, default: adaptive_label)
 *   --split       val,test (comma-separated, omit to read all unsplit + split files)
 *
 * Output: metrics/{stage}/{dataset}/{gate}/{classifierOrParam}.json
 *         metrics/{stage}/{dataset}/{gate}/{classifierOrParam}.{split}.json  (when --split)
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, basename } from "node:path";
import {
  type ClassifierPrompt,
  type PreCascadePrompt,
  type RouterPrompt,
  type ThreeTierPrompt,
  ensureDir,
  gateNameFor,
  resolveLabelFields,
} from "./runner/shared.js";
import { RUNS_DIR, METRICS_DIR, DEFAULT_W_ERROR, DEFAULT_W_CAS } from "./config.js";

// ── Types ──

interface ClassifierMetrics {
  dataset: string;
  classifier: string;
  promptCount: number;
  accuracy: number;
  macroAccuracy: number;
  ece: number;
  avgConfidenceCorrect: number;
  avgConfidenceIncorrect: number;
  silentErrorRate: number;
  regretCascadeRate: number;
  cascadePrecision: number;
  cascadeRate: number;
  cost: number;
  avgLatencyMs: number;
  perClass: Record<string, { total: number; correct: number; accuracy: number }>;
}

interface PreCascadeMetrics {
  dataset: string;
  params: { kwWeight: number; semWeight: number };
  promptCount: number;
  accuracy: number;
  cascadeRate: number;
  silentErrorRate: number;
  cascadePrecision: number;
  cost: number;
  regretCascadeRate: number;
  ece: number;
  avgConfidenceCorrect: number;
  avgConfidenceIncorrect: number;
  kwAvgConfidenceCorrect: number;
  kwAvgConfidenceIncorrect: number;
  semAvgConfidenceCorrect: number;
  semAvgConfidenceIncorrect: number;
  perClass: Record<string, { total: number; correct: number; accuracy: number }>;
}

interface RouterMetrics {
  dataset: string;
  promptCount: number;
  overallAccuracy: number;
  llmConditionalAccuracy: number;
  cascadeRate: number;
  avgLatencyMs: number;
  avgPreLatencyMs: number;
  avgLlmLatencyMs: number;
  perClass: Record<string, { total: number; correct: number; accuracy: number }>;
}

interface ThreeTierMetrics {
  dataset: string;
  params: { margin: number; entropy: number };
  promptCount: number;
  accuracy: number;
  cascadeRate: number;
  silentErrorRate: number;
  cascadePrecision: number;
  cost: number;
  regretCascadeRate: number;
  keywordRate: number;
  semanticRate: number;
  keywordAccuracy: number;
  semanticAccuracy: number;
  marginP50: number;
  marginP90: number;
  entropyP50: number;
  entropyP90: number;
  perClass: Record<string, { total: number; correct: number; accuracy: number }>;
}

// ── CLI ──

function parseArgs() {
  const raw: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1]?.startsWith("--") ? "true" : argv[++i];
      raw[key] = val ?? "true";
    }
  }
  return {
    stage: raw.stage as string,
    dataset: raw.dataset,
    split: raw.split,
    raw,
  };
}

const ALL_STAGES = ["classifier", "pre-cascade", "three-tier", "router"] as const;

// ── Main ──

async function main() {
  const { stage, dataset, split, raw } = parseArgs();

  if (!dataset) {
    console.error("Error: --dataset is required (comma-separated for multiple)");
    process.exit(1);
  }
  if (!stage) {
    console.error(
      "Error: --stage is required (classifier | pre-cascade | three-tier | router | all)",
    );
    process.exit(1);
  }

  const labelFields = resolveLabelFields(raw);

  const stages: readonly string[] = stage === "all"
    ? ALL_STAGES
    : [stage];

  const datasets = dataset.split(",").map((s) => s.trim()).filter(Boolean);
  const splits = split
    ? split.split(",").map((s) => s.trim()).filter(Boolean)
    : [undefined];

  const splitLabel = splits.map((s) => s ?? "-").join(",");

  for (const labelField of labelFields) {
    const gateName = gateNameFor(labelField);
    console.log(
      `Computing metrics | label field: ${labelField} | gate: ${gateName} | datasets: ${datasets.join(", ")} | splits: ${splitLabel}`,
    );

    for (const st of stages) {
      for (const ds of datasets) {
        ensureDir(join(METRICS_DIR, st, ds, gateName));

        for (const sp of splits) {
          switch (st) {
            case "classifier":
              handleClassifier(ds, sp, gateName);
              break;
            case "pre-cascade":
              handlePreCascade(ds, sp, gateName);
              break;
            case "three-tier":
              handleThreeTier(ds, sp, gateName);
              break;
            case "router":
              handleRouter(ds, sp, gateName);
              break;
          }
        }
      }
    }
  }
}

// ── Stage: Classifier ──

function handleClassifier(dataset: string, split: string | undefined, gateName: string) {
  const dir = join(RUNS_DIR, dataset, gateName, "classifier");
  if (!existsSync(dir)) {
    console.log(`No runs found at ${dir}`);
    return;
  }

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    if (!matchSplit(file, split)) continue;

    const classifierName = basename(file, ".jsonl").replace(/\.(val|test)$/, "");
    const lines = readFileSync(join(dir, file), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const prompts: ClassifierPrompt[] = lines.map((l) => JSON.parse(l));

    const correct = prompts.filter((p) => p.correct).length;
    const accuracy = correct / prompts.length;

    // ECE: bin predictions by confidence, compare avg confidence vs accuracy per bin
    const ece = computeECE(prompts);

    // Avg classifier confidence (confScore) for correct vs incorrect.
    const correctPrompts = prompts.filter((p) => p.correct);
    const incorrectPrompts = prompts.filter((p) => !p.correct);
    const avgConfCorrect =
      correctPrompts.length > 0
        ? correctPrompts.reduce((s, p) => s + p.confScore, 0) /
          correctPrompts.length
        : 0;
    const avgConfIncorrect =
      incorrectPrompts.length > 0
        ? incorrectPrompts.reduce((s, p) => s + p.confScore, 0) /
          incorrectPrompts.length
        : 0;

    // Treat the classifier's own `isConfident` as a mini-gate.
    const cascadeCount = prompts.filter((p) => !p.isConfident).length;
    const cascadeRate = cascadeCount / prompts.length;
    const silentErrors = prompts.filter((p) => !p.correct && p.isConfident).length;
    const silentErrorRate = silentErrors / prompts.length;
    const correctButCascade = prompts.filter((p) => p.correct && !p.isConfident).length;
    const regretCascadeRate = correctButCascade / prompts.length;
    const wrongCascaded = prompts.filter((p) => !p.correct && !p.isConfident).length;
    const cascadePrecision = cascadeCount > 0 ? wrongCascaded / cascadeCount : 0;
    const cost = DEFAULT_W_ERROR * silentErrorRate + DEFAULT_W_CAS * regretCascadeRate;

    // Avg latency
    const avgLatencyMs = Math.round(
      prompts.reduce((s, p) => s + p.latencyMs, 0) / prompts.length,
    );

    // Per-class
    const perClass = buildPerClass(prompts);

    // Macro accuracy (mean of per-class accuracies)
    const classAccuracies = Object.values(perClass).map((c) => c.accuracy);
    const macroAccuracy =
      classAccuracies.length > 0
        ? classAccuracies.reduce((s, a) => s + a, 0) / classAccuracies.length
        : 0;

    const metrics: ClassifierMetrics = {
      dataset,
      classifier: classifierName,
      promptCount: prompts.length,
      accuracy: round(accuracy),
      macroAccuracy: round(macroAccuracy),
      ece: round(ece),
      avgConfidenceCorrect: round(avgConfCorrect),
      avgConfidenceIncorrect: round(avgConfIncorrect),
      silentErrorRate: round(silentErrorRate),
      regretCascadeRate: round(regretCascadeRate),
      cascadePrecision: round(cascadePrecision),
      cascadeRate: round(cascadeRate),
      cost: round(cost),
      avgLatencyMs,
      perClass,
    };

    writeMetrics("classifier", dataset, gateName, file.replace(".jsonl", ".json"), metrics);
  }
}

// ── Stage: Pre-Cascade ──

function handlePreCascade(dataset: string, split: string | undefined, gateName: string) {
  const dir = join(RUNS_DIR, dataset, gateName, "pre-cascade");
  if (!existsSync(dir)) {
    console.log(`No runs found at ${dir}`);
    return;
  }

  const allMetrics: PreCascadeMetrics[] = [];

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    if (!matchSplit(file, split)) continue;

    const lines = readFileSync(join(dir, file), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const prompts: PreCascadePrompt[] = lines.map((l) => JSON.parse(l));

    const correct = prompts.filter((p) => p.correct).length;
    const accuracy = correct / prompts.length;

    const cascaded = prompts.filter((p) => p.cascade);
    const cascadeRate = cascaded.length / prompts.length;

    // Silent error rate: wrong but NOT cascaded
    const silentErrors = prompts.filter((p) => !p.correct && !p.cascade).length;
    const silentErrorRate = silentErrors / prompts.length;

    // Cascade precision: among cascaded, how many were actually wrong?
    const wrongCascaded = cascaded.filter((p) => !p.correct).length;
    const cascadePrecision =
      cascaded.length > 0 ? wrongCascaded / cascaded.length : 0;

    // Regret cascade rate: correct but cascaded (wasteful)
    const correctButCascade = prompts.filter(
      (p) => p.correct && p.cascade,
    ).length;
    const regretCascadeRate = correctButCascade / prompts.length;

    // Routing cost: penalise silent errors and regret cascades (wasted LLM).
    const cost = DEFAULT_W_ERROR * silentErrorRate + DEFAULT_W_CAS * regretCascadeRate;

    // Per-classifier confidence separation (confScore of correct vs incorrect).
    const kwAvgConfCorrect = meanConfidence(prompts, true, "kw");
    const kwAvgConfIncorrect = meanConfidence(prompts, false, "kw");
    const semAvgConfCorrect = meanConfidence(prompts, true, "sem");
    const semAvgConfIncorrect = meanConfidence(prompts, false, "sem");

    // Overall pre-cascade confidence separation (decision confScore).
    const correctPrompts = prompts.filter((p) => p.correct);
    const incorrectPrompts = prompts.filter((p) => !p.correct);
    const avgConfCorrect =
      correctPrompts.length > 0
        ? correctPrompts.reduce((s, p) => s + p.confScore, 0) /
          correctPrompts.length
        : 0;
    const avgConfIncorrect =
      incorrectPrompts.length > 0
        ? incorrectPrompts.reduce((s, p) => s + p.confScore, 0) /
          incorrectPrompts.length
        : 0;

    // Parse params from filename: kw{0.3}_sem{0.7}.jsonl or .{split}.jsonl
    const base = basename(file, ".jsonl");
    const paramStr = split ? base.replace(new RegExp(`\\.${split}$`), "") : base;
    const paramMatch = paramStr.match(
      /^kw([\d.]+)_sem([\d.]+)$/,
    );
    const params = paramMatch
      ? {
          kwWeight: parseFloat(paramMatch[1]),
          semWeight: parseFloat(paramMatch[2]),
        }
      : { kwWeight: 0, semWeight: 0 };

    const metrics: PreCascadeMetrics = {
      dataset,
      params,
      promptCount: prompts.length,
      accuracy: round(accuracy),
      cascadeRate: round(cascadeRate),
      silentErrorRate: round(silentErrorRate),
      cascadePrecision: round(cascadePrecision),
      cost: round(cost),
      regretCascadeRate: round(regretCascadeRate),
      ece: round(computeECE(prompts)),
      avgConfidenceCorrect: round(avgConfCorrect),
      avgConfidenceIncorrect: round(avgConfIncorrect),
      kwAvgConfidenceCorrect: round(kwAvgConfCorrect),
      kwAvgConfidenceIncorrect: round(kwAvgConfIncorrect),
      semAvgConfidenceCorrect: round(semAvgConfCorrect),
      semAvgConfidenceIncorrect: round(semAvgConfIncorrect),
      perClass: buildPerClass(prompts),
    };

    allMetrics.push(metrics);
    writeMetrics("pre-cascade", dataset, gateName, file.replace(".jsonl", ".json"), metrics);
  }

  // Write combined compare.json with best params
  if (allMetrics.length > 1) {
    const best = allMetrics.reduce((a, b) =>
      a.cost < b.cost ? a : b,
    );
    const compare = {
      dataset,
      split: split ?? null,
      runs: allMetrics.map((m) => ({
        params: m.params,
        accuracy: m.accuracy,
        cascadeRate: m.cascadeRate,
        silentErrorRate: m.silentErrorRate,
        cascadePrecision: m.cascadePrecision,
        cost: m.cost,
      })),
      best: {
        params: best.params,
        cost: best.cost,
        silentErrorRate: best.silentErrorRate,
        cascadeRate: best.cascadeRate,
      },
    };

    const compareName = split ? `compare.${split}.json` : "compare.json";
    writeMetrics("pre-cascade", dataset, gateName, compareName, compare);
  }
}

// ── Stage: Three-Tier ──

function handleThreeTier(dataset: string, split: string | undefined, gateName: string) {
  const dir = join(RUNS_DIR, dataset, gateName, "three-tier");
  if (!existsSync(dir)) {
    console.log(`No runs found at ${dir}`);
    return;
  }

  const allMetrics: ThreeTierMetrics[] = [];

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    if (!matchSplit(file, split)) continue;

    const lines = readFileSync(join(dir, file), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const prompts: ThreeTierPrompt[] = lines.map((l) => JSON.parse(l));

    const total = prompts.length;
    const correct = prompts.filter((p) => p.correct).length;
    const accuracy = correct / total;

    const cascaded = prompts.filter((p) => p.cascade);
    const cascadeRate = cascaded.length / total;

    // Silent error rate: wrong but NOT cascaded (should have deferred).
    const silentErrors = prompts.filter((p) => !p.correct && !p.cascade).length;
    const silentErrorRate = silentErrors / total;

    // Cascade precision: among deferrals, how many were actually wrong?
    const wrongCascaded = cascaded.filter((p) => !p.correct).length;
    const cascadePrecision =
      cascaded.length > 0 ? wrongCascaded / cascaded.length : 0;

    // Regret cascade rate: correct but cascaded (wasted LLM).
    const correctButCascade = prompts.filter((p) => p.correct && p.cascade).length;
    const regretCascadeRate = correctButCascade / total;

    const cost = DEFAULT_W_ERROR * silentErrorRate + DEFAULT_W_CAS * regretCascadeRate;

    // Tier distribution + per-tier accuracy.
    const keywordRows = prompts.filter((p) => p.stage === "keyword");
    const semanticRows = prompts.filter((p) => p.stage === "semantic");
    const keywordRate = keywordRows.length / total;
    const semanticRate = semanticRows.length / total;
    const keywordAccuracy =
      keywordRows.length > 0
        ? keywordRows.filter((p) => p.correct).length / keywordRows.length
        : 0;
    const semanticAccuracy =
      semanticRows.length > 0
        ? semanticRows.filter((p) => p.correct).length / semanticRows.length
        : 0;

    const margins = prompts.map((p) => p.margin).sort((a, b) => a - b);
    const entropies = prompts.map((p) => p.entropy).sort((a, b) => a - b);

    // Parse params from filename: m{0.54}_H{0.78}.jsonl or m{0.54}_H{0.78}.{split}.jsonl
    const base = basename(file, ".jsonl");
    const paramStr = split ? base.replace(new RegExp(`\\.${split}$`), "") : base;
    const paramMatch = paramStr.match(/^m([\d.]+)_H([\d.]+)$/);
    const params = paramMatch
      ? {
          margin: parseFloat(paramMatch[1]),
          entropy: parseFloat(paramMatch[2]),
        }
      : { margin: 0, entropy: 0 };

    const metrics: ThreeTierMetrics = {
      dataset,
      params,
      promptCount: total,
      accuracy: round(accuracy),
      cascadeRate: round(cascadeRate),
      silentErrorRate: round(silentErrorRate),
      cascadePrecision: round(cascadePrecision),
      cost: round(cost),
      regretCascadeRate: round(regretCascadeRate),
      keywordRate: round(keywordRate),
      semanticRate: round(semanticRate),
      keywordAccuracy: round(keywordAccuracy),
      semanticAccuracy: round(semanticAccuracy),
      marginP50: round(margins[Math.floor(margins.length * 0.5)] ?? 0),
      marginP90: round(margins[Math.floor(margins.length * 0.9)] ?? 0),
      entropyP50: round(entropies[Math.floor(entropies.length * 0.5)] ?? 0),
      entropyP90: round(entropies[Math.floor(entropies.length * 0.9)] ?? 0),
      perClass: buildPerClass(prompts),
    };

    allMetrics.push(metrics);
    writeMetrics("three-tier", dataset, gateName, file.replace(".jsonl", ".json"), metrics);
  }

  // Write combined compare.json with best params
  if (allMetrics.length > 1) {
    const best = allMetrics.reduce((a, b) =>
      a.cost < b.cost ? a : b,
    );
    const compare = {
      dataset,
      split: split ?? null,
      runs: allMetrics.map((m) => ({
        params: m.params,
        accuracy: m.accuracy,
        cascadeRate: m.cascadeRate,
        silentErrorRate: m.silentErrorRate,
        cascadePrecision: m.cascadePrecision,
        regretCascadeRate: m.regretCascadeRate,
        cost: m.cost,
        keywordRate: m.keywordRate,
        semanticRate: m.semanticRate,
      })),
      best: {
        params: best.params,
        cost: best.cost,
        silentErrorRate: best.silentErrorRate,
        cascadeRate: best.cascadeRate,
      },
    };

    const compareName = split ? `compare.${split}.json` : "compare.json";
    writeMetrics("three-tier", dataset, gateName, compareName, compare);
  }
}

// ── Stage: Router ──

function handleRouter(dataset: string, split: string | undefined, gateName: string) {
  const dir = join(RUNS_DIR, dataset, gateName, "router");
  if (!existsSync(dir)) {
    console.log(`No runs found at ${dir}`);
    return;
  }

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    if (!matchSplit(file, split)) continue;

    const lines = readFileSync(join(dir, file), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const prompts: RouterPrompt[] = lines.map((l) => JSON.parse(l));

    const correct = prompts.filter((p) => p.correct).length;
    const overallAccuracy = correct / prompts.length;

    // LLM conditional accuracy
    const cascaded = prompts.filter((p) => p.cascaded);
    const llmCorrect = cascaded.filter((p) => p.correct).length;
    const llmConditionalAccuracy =
      cascaded.length > 0 ? llmCorrect / cascaded.length : 0;

    const cascadeRate = cascaded.length / prompts.length;

    // Average latency: weighted by cascade decision
    const avgPreLatencyMs = Math.round(
      prompts.reduce((s, p) => s + p.preLatencyMs, 0) / prompts.length,
    );
    const avgLlmLatencyMs =
      cascaded.length > 0
        ? Math.round(
            cascaded.reduce((s, p) => s + p.llmLatencyMs, 0) / cascaded.length,
          )
        : 0;
    const avgLatencyMs = Math.round(
      prompts.reduce((s, p) => s + p.totalLatencyMs, 0) / prompts.length,
    );

    const metrics: RouterMetrics = {
      dataset,
      promptCount: prompts.length,
      overallAccuracy: round(overallAccuracy),
      llmConditionalAccuracy: round(llmConditionalAccuracy),
      cascadeRate: round(cascadeRate),
      avgLatencyMs,
      avgPreLatencyMs,
      avgLlmLatencyMs,
      perClass: buildPerClass(prompts),
    };

    writeMetrics("router", dataset, gateName, file.replace(".jsonl", ".json"), metrics);
  }
}

// ── Helpers ──

/**
 * Returns true if the file matches the given split.
 * - split = "val": matches `*.val.jsonl`
 * - split = undefined: matches files WITHOUT a known split suffix (backward compat)
 */
function matchSplit(filename: string, split?: string): boolean {
  const knownSplits = ["val", "test"];
  if (split) {
    return filename.endsWith(`.${split}.jsonl`);
  }
  // No split specified → exclude files with known split suffixes
  return !knownSplits.some((s) => filename.endsWith(`.${s}.jsonl`));
}

function computeECE(
  prompts: Array<{ scores: Record<string, number>; correct: boolean }>,
  bins: number = 10,
): number {
  if (prompts.length === 0) return 0;

  // Sort by confidence and partition into equal-mass bins
  const sorted = [...prompts].sort((a, b) => top1(a) - top1(b));
  const binSize = Math.ceil(sorted.length / bins);

  let ece = 0;
  for (let i = 0; i < bins; i++) {
    const slice = sorted.slice(i * binSize, (i + 1) * binSize);
    if (slice.length === 0) continue;

    const avgConf = slice.reduce((s, p) => s + top1(p), 0) / slice.length;
    const acc = slice.filter((p) => p.correct).length / slice.length;
    ece += (slice.length / prompts.length) * Math.abs(avgConf - acc);
  }

  return ece;
}

function buildPerClass(
  prompts: Array<{ correct: boolean; truth?: string; expected?: string }>,
): Record<string, { total: number; correct: number; accuracy: number }> {
  const map = new Map<string, { total: number; correct: number }>();
  for (const p of prompts) {
    const label = (p as any).truth ?? (p as any).expected;
    const s = map.get(label) ?? { total: 0, correct: 0 };
    s.total++;
    if (p.correct) s.correct++;
    map.set(label, s);
  }
  const result: Record<
    string,
    { total: number; correct: number; accuracy: number }
  > = {};
  for (const [label, s] of map) {
    result[label] = {
      total: s.total,
      correct: s.correct,
      accuracy: round(s.correct / s.total),
    };
  }
  return result;
}

function writeMetrics(
  stage: string,
  dataset: string,
  gateName: string,
  filename: string,
  data: unknown,
): void {
  const outDir = join(METRICS_DIR, stage, dataset, gateName);
  ensureDir(outDir);
  const outPath = join(outDir, filename);
  writeFileSync(outPath, JSON.stringify(data, null, 2), "utf-8");
  console.log(`Metrics → ${outPath}`);
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Derive the top-1 confidence score from a prompt's scores map. */
function top1(p: { scores: Record<string, number> }): number {
  return Math.max(0, ...Object.values(p.scores));
}

/** Average confScore of correct/incorrect prompts for one pre-cascade classifier. */
function meanConfidence(
  prompts: PreCascadePrompt[],
  correct: boolean,
  key: "kw" | "sem",
): number {
  const rows = prompts.filter((p) => p.correct === correct);
  if (rows.length === 0) return 0;
  return rows.reduce((s, p) => s + p[key].confScore, 0) / rows.length;
}

// ── Entry ──

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
