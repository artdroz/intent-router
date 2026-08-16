/**
 * Combine-metrics — reads per-dataset metrics JSON from metrics/{stage}/ and
 * produces aggregated overall JSON in metrics/overall/ with weighted or macro averages
 * and variance across datasets.
 *
 * Prerequisite: metrics/{stage}/{dataset}/*.json must exist (run
 *   compute-metrics.ts first).
 *
 * Usage:
 *   npx tsx evaluate/evaluator/combine-metrics.ts \
 *     --stage classifier --dataset k8,nextjs
 *   npx tsx evaluate/evaluator/combine-metrics.ts \
 *     --stage router --dataset k8,nextjs --split val
 *
 *   --stage    classifier | pre-cascade | router | all (required)
 *   --dataset  k8,nextjs,pythonc,vscode (comma-separated, required)
 *   --split    val,test (comma-separated, omit to read unsplit files only)
 *
 * Output: metrics/overall/{stage}.json
 *         metrics/overall/{stage}.{split}.json  (when --split)
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join, basename } from "node:path";
import type { ClassifierPrompt } from "./runner/shared.js";
import { ensureDir } from "./runner/shared.js";
import { RUNS_DIR, METRICS_DIR } from "./config.js";

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
  avgLatencyMs: number;
  perClass: Record<string, { total: number; correct: number; accuracy: number }>;
}

interface PreCascadeMetrics {
  dataset: string;
  params: { margin: number; kwWeight: number; semWeight: number };
  promptCount: number;
  accuracy: number;
  cascadeRate: number;
  silentErrorRate: number;
  cascadePrecision: number;
  regretCost: number;
  regretCascadeRate: number;
  marginP50: number;
  marginP90: number;
  entropyP50: number;
  entropyP90: number;
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

// ── Overall output types ──

interface OverallClassifier {
  stage: "classifier";
  totalPrompts: number;
  datasets: string[];
  classifiers: Record<
    string,
    {
      accuracy: { weighted: number; macro: number; variance: number };
      ece: { weighted: number; macro: number; variance: number; pooled: number };
      latencyMs: { weighted: number; variance: number };
      perDataset: Record<
        string,
        {
          promptCount: number;
          accuracy: number;
          ece: number;
          avgConfidenceCorrect: number;
          avgConfidenceIncorrect: number;
          avgLatencyMs: number;
        }
      >;
    }
  >;
}

interface OverallPreCascade {
  stage: "pre-cascade";
  totalPrompts: number;
  datasets: string[];
  runs: Record<
    string, // param key like "m0.15_kw0.3_sem0.7"
    {
      cascadeRate: { weighted: number; variance: number };
      silentErrorRate: { weighted: number; variance: number };
      cascadePrecision: { weighted: number; variance: number };
      perDataset: Record<
        string,
        {
          promptCount: number;
          cascadeRate: number;
          silentErrorRate: number;
          cascadePrecision: number;
          regretCost: number;
        }
      >;
    }
  >;
}

interface OverallRouter {
  stage: "router";
  totalPrompts: number;
  datasets: string[];
  llmConditionalAccuracy: { weighted: number; variance: number };
  overallAccuracy: { weighted: number; variance: number };
  latencyMs: { weighted: number; variance: number };
  perDataset: Record<
    string,
    {
      promptCount: number;
      overallAccuracy: number;
      llmConditionalAccuracy: number;
      cascadeRate: number;
      avgLatencyMs: number;
    }
  >;
}

// ── Main ──

async function main() {
  const { stage, dataset, split } = parseArgs();

  const allDatasets = listDatasets();
  if (allDatasets.length === 0) {
    console.log("No datasets found in metrics/");
    return;
  }

  if (!dataset) {
    console.error("Error: --dataset is required (comma-separated for multiple)");
    process.exit(1);
  }
  if (!stage) {
    console.error("Error: --stage is required (classifier | pre-cascade | router | all)");
    process.exit(1);
  }

  const stages: readonly string[] = stage === "all"
    ? ALL_STAGES
    : [stage];

  const datasets = dataset.split(",").map((s) => s.trim()).filter(Boolean);
  const splits = split
    ? split.split(",").map((s) => s.trim()).filter(Boolean)
    : [undefined];

  // Validate requested datasets exist
  for (const ds of datasets) {
    if (!allDatasets.includes(ds)) {
      console.error(`Dataset "${ds}" not found. Available: ${allDatasets.join(", ")}`);
      process.exit(1);
    }
  }

  const splitLabel = splits.map((s) => s ?? "-").join(",");
  console.log(`Combining metrics for ${datasets.length} dataset(s): ${datasets.join(", ")} | splits: ${splitLabel}`);

  for (const st of stages) {
    for (const sp of splits) {
      switch (st) {
        case "classifier":
          handleClassifier(datasets, sp);
          break;
        case "pre-cascade":
          handlePreCascade(datasets, sp);
          break;
        case "router":
          handleRouter(datasets, sp);
          break;
      }
    }
  }
}

// ── Helpers ──

function listDatasets(): string[] {
  const classifierDir = join(METRICS_DIR, "classifier");
  if (!existsSync(classifierDir)) return [];
  return readdirSync(classifierDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function readJsonFiles<T>(stage: string, dataset: string, split?: string): Record<string, T> {
  const dir = join(METRICS_DIR, stage, dataset);
  if (!existsSync(dir)) return {};

  const knownSplits = ["val", "test"];
  const result: Record<string, T> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    // Skip compare.json (pre-cascade sweep summary)
    if (file === "compare.json" || file.startsWith("compare.")) continue;

    // Filter by split suffix
    if (split) {
      if (!file.endsWith(`.${split}.json`)) continue;
    } else {
      // No split → exclude files with known split suffixes
      if (knownSplits.some((s) => file.endsWith(`.${s}.json`))) continue;
    }

    const key = basename(file, ".json").replace(/\.(val|test)$/, "");
    const raw = readFileSync(join(dir, file), "utf-8");
    result[key] = JSON.parse(raw);
  }
  return result;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function variance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
}

// ── Stage: Classifier ──

function handleClassifier(datasets: string[], split?: string) {
  // Collect all per-dataset classifier metrics
  type ClassifierMap = Map<
    string, // classifier name
    {
      dataset: string;
      promptCount: number;
      accuracy: number;
      macroAccuracy: number;
      ece: number;
      avgConfidenceCorrect: number;
      avgConfidenceIncorrect: number;
      avgLatencyMs: number;
    }[]
  >;

  const byClassifier: ClassifierMap = new Map();

  for (const ds of datasets) {
    const files = readJsonFiles<ClassifierMetrics>("classifier", ds, split);
    for (const [classifierName, m] of Object.entries(files)) {
      if (!byClassifier.has(classifierName)) {
        byClassifier.set(classifierName, []);
      }
      byClassifier.get(classifierName)!.push({
        dataset: ds,
        promptCount: m.promptCount,
        accuracy: m.accuracy,
        macroAccuracy: m.macroAccuracy,
        ece: m.ece,
        avgConfidenceCorrect: m.avgConfidenceCorrect,
        avgConfidenceIncorrect: m.avgConfidenceIncorrect,
        avgLatencyMs: m.avgLatencyMs,
      });
    }
  }

  const totalPrompts = [...byClassifier.values()]
    .flat()
    .reduce((s, v) => s + v.promptCount, 0);

  const classifiers: OverallClassifier["classifiers"] = {};

  for (const [name, entries] of byClassifier) {
    // Weighted accuracy + macro
    const weightedAccuracy = round(
      entries.reduce((s, e) => s + e.accuracy * e.promptCount, 0) /
        entries.reduce((s, e) => s + e.promptCount, 0),
    );
    const macroAccuracy = round(
      entries.reduce((s, e) => s + e.macroAccuracy, 0) / entries.length,
    );
    const accuracyVariance = round(
      variance(entries.map((e) => e.accuracy)),
    );

    // Weighted ECE + macro ECE
    const weightedEce = round(
      entries.reduce((s, e) => s + e.ece * e.promptCount, 0) /
        entries.reduce((s, e) => s + e.promptCount, 0),
    );
    const macroEce = round(
      entries.reduce((s, e) => s + e.ece, 0) / entries.length,
    );
    const eceVariance = round(variance(entries.map((e) => e.ece)));

    // Pooled ECE: read raw runs and compute ECE across all datasets
    const pooledEce = round(computePooledECE(name, entries.map((e) => e.dataset), split));

    // Per-dataset breakdown
    const perDataset: OverallClassifier["classifiers"][string]["perDataset"] = {};
    for (const e of entries) {
      perDataset[e.dataset] = {
        promptCount: e.promptCount,
        accuracy: e.accuracy,
        ece: e.ece,
        avgConfidenceCorrect: e.avgConfidenceCorrect,
        avgConfidenceIncorrect: e.avgConfidenceIncorrect,
        avgLatencyMs: e.avgLatencyMs,
      };
    }

    // Weighted latency
    const weightedLatency = Math.round(
      entries.reduce((s, e) => s + e.avgLatencyMs * e.promptCount, 0) /
        entries.reduce((s, e) => s + e.promptCount, 0),
    );
    const latencyVariance = round(variance(entries.map((e) => e.avgLatencyMs)));

    classifiers[name] = {
      accuracy: { weighted: weightedAccuracy, macro: macroAccuracy, variance: accuracyVariance },
      ece: { weighted: weightedEce, macro: macroEce, variance: eceVariance, pooled: pooledEce },
      latencyMs: { weighted: weightedLatency, variance: latencyVariance },
      perDataset,
    };
  }

  const result: OverallClassifier = {
    stage: "classifier",
    totalPrompts,
    datasets,
    classifiers,
  };

  writeOverall("classifier", result, split);
}

function computePooledECE(
  classifierName: string,
  datasetNames: string[],
  split?: string,
): number {
  // Pool all raw predictions across datasets
  const allPrompts: ClassifierPrompt[] = [];

  for (const ds of datasetNames) {
    const runsDir = join(RUNS_DIR, ds, "classifier");
    const suffix = split ? `.${split}` : "";
    const jsonlPath = join(runsDir, `${classifierName}${suffix}.jsonl`);
    if (!existsSync(jsonlPath)) continue;

    const lines = readFileSync(jsonlPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const line of lines) {
      allPrompts.push(JSON.parse(line));
    }
  }

  if (allPrompts.length === 0) return 0;

  return computeECE(allPrompts);
}

function computeECE(prompts: ClassifierPrompt[], bins: number = 10): number {
  if (prompts.length === 0) return 0;

  const sorted = [...prompts].sort(
    (a, b) => top1(a) - top1(b),
  );
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

function top1(p: { scores: Record<string, number> }): number {
  return Math.max(0, ...Object.values(p.scores));
}

// ── Stage: Pre-Cascade ──

function handlePreCascade(datasets: string[], split?: string) {
  // Group by param key across datasets
  type ParamsMap = Map<
    string, // param key
    {
      dataset: string;
      promptCount: number;
      cascadeRate: number;
      silentErrorRate: number;
      cascadePrecision: number;
      regretCost: number;
    }[]
  >;

  const byParams: ParamsMap = new Map();

  for (const ds of datasets) {
    const files = readJsonFiles<PreCascadeMetrics>("pre-cascade", ds, split);
    for (const [paramKey, m] of Object.entries(files)) {
      if (!byParams.has(paramKey)) {
        byParams.set(paramKey, []);
      }
      byParams.get(paramKey)!.push({
        dataset: ds,
        promptCount: m.promptCount,
        cascadeRate: m.cascadeRate,
        silentErrorRate: m.silentErrorRate,
        cascadePrecision: m.cascadePrecision,
        regretCost: m.regretCost,
      });
    }
  }

  const totalPrompts = [...byParams.values()]
    .flat()
    .reduce((s, v) => s + v.promptCount, 0);

  const runs: OverallPreCascade["runs"] = {};

  for (const [paramKey, entries] of byParams) {
    // Weighted cascade rate
    const wCascadeRate = round(
      entries.reduce((s, e) => s + e.cascadeRate * e.promptCount, 0) /
        entries.reduce((s, e) => s + e.promptCount, 0),
    );
    const vCascadeRate = round(variance(entries.map((e) => e.cascadeRate)));

    // Weighted silent error rate
    const wSilentErrorRate = round(
      entries.reduce((s, e) => s + e.silentErrorRate * e.promptCount, 0) /
        entries.reduce((s, e) => s + e.promptCount, 0),
    );
    const vSilentErrorRate = round(
      variance(entries.map((e) => e.silentErrorRate)),
    );

    // Weighted cascade precision
    const wCascadePrecision = round(
      entries.reduce((s, e) => s + e.cascadePrecision * e.promptCount, 0) /
        entries.reduce((s, e) => s + e.promptCount, 0),
    );
    const vCascadePrecision = round(
      variance(entries.map((e) => e.cascadePrecision)),
    );

    const perDataset: OverallPreCascade["runs"][string]["perDataset"] = {};
    for (const e of entries) {
      perDataset[e.dataset] = {
        promptCount: e.promptCount,
        cascadeRate: e.cascadeRate,
        silentErrorRate: e.silentErrorRate,
        cascadePrecision: e.cascadePrecision,
        regretCost: e.regretCost,
      };
    }

    runs[paramKey] = {
      cascadeRate: { weighted: wCascadeRate, variance: vCascadeRate },
      silentErrorRate: { weighted: wSilentErrorRate, variance: vSilentErrorRate },
      cascadePrecision: {
        weighted: wCascadePrecision,
        variance: vCascadePrecision,
      },
      perDataset,
    };
  }

  const result: OverallPreCascade = {
    stage: "pre-cascade",
    totalPrompts,
    datasets,
    runs,
  };

  writeOverall("pre-cascade", result, split);
}

// ── Stage: Router ──

function handleRouter(datasets: string[], split?: string) {
  const entries: {
    dataset: string;
    promptCount: number;
    overallAccuracy: number;
    llmConditionalAccuracy: number;
    cascadeRate: number;
    avgLatencyMs: number;
  }[] = [];

  for (const ds of datasets) {
    const files = readJsonFiles<RouterMetrics>("router", ds, split);
    for (const [, m] of Object.entries(files)) {
      entries.push({
        dataset: ds,
        promptCount: m.promptCount,
        overallAccuracy: m.overallAccuracy,
        llmConditionalAccuracy: m.llmConditionalAccuracy,
        cascadeRate: m.cascadeRate,
        avgLatencyMs: m.avgLatencyMs,
      });
    }
  }

  const totalPrompts = entries.reduce((s, e) => s + e.promptCount, 0);

  // Weighted LLM conditional accuracy
  const wLlmCondAcc = round(
    entries.reduce((s, e) => s + e.llmConditionalAccuracy * e.promptCount, 0) /
      entries.reduce((s, e) => s + e.promptCount, 0),
  );
  const vLlmCondAcc = round(
    variance(entries.map((e) => e.llmConditionalAccuracy)),
  );

  // Weighted overall accuracy
  const wOverallAcc = round(
    entries.reduce((s, e) => s + e.overallAccuracy * e.promptCount, 0) /
      entries.reduce((s, e) => s + e.promptCount, 0),
  );
  const vOverallAcc = round(variance(entries.map((e) => e.overallAccuracy)));

  // Weighted latency
  const wLatency = round(
    entries.reduce((s, e) => s + e.avgLatencyMs * e.promptCount, 0) /
      entries.reduce((s, e) => s + e.promptCount, 0),
  );
  const vLatency = round(variance(entries.map((e) => e.avgLatencyMs)));

  // Per-dataset breakdown
  const perDataset: OverallRouter["perDataset"] = {};
  for (const e of entries) {
    perDataset[e.dataset] = {
      promptCount: e.promptCount,
      overallAccuracy: e.overallAccuracy,
      llmConditionalAccuracy: e.llmConditionalAccuracy,
      cascadeRate: e.cascadeRate,
      avgLatencyMs: e.avgLatencyMs,
    };
  }

  const result: OverallRouter = {
    stage: "router",
    totalPrompts,
    datasets,
    llmConditionalAccuracy: { weighted: wLlmCondAcc, variance: vLlmCondAcc },
    overallAccuracy: { weighted: wOverallAcc, variance: vOverallAcc },
    latencyMs: { weighted: wLatency, variance: vLatency },
    perDataset,
  };

  writeOverall("router", result, split);
}

// ── Write ──

function writeOverall(stage: string, data: unknown, split?: string): void {
  const outDir = join(METRICS_DIR, "overall");
  ensureDir(outDir);
  const filename = split ? `${stage}.${split}.json` : `${stage}.json`;
  const outPath = join(outDir, filename);
  writeFileSync(outPath, JSON.stringify(data, null, 2), "utf-8");
  console.log(`Overall metrics → ${outPath}`);
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
    dataset: raw.dataset as string | undefined,
    split: raw.split as string | undefined,
  };
}

const ALL_STAGES = ["classifier", "pre-cascade", "router"] as const;

main().catch(console.error);
