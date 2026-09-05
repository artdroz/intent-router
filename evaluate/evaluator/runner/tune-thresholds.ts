/**
 * Threshold Tuning — sweeps margin × entropy over pooled val rows to find
 * the combination that minimises Routing Regret Cost.
 *
 *   Regret Cost = (W_Error × Silent_Error_Rate) + (W_Doubt × Regret_Cascade_Rate)
 *
 * Silent Error Rate = wrong predictions NOT cascaded (should have cascaded).
 * Regret Cascade Rate = correct predictions that DID cascade (wasted LLM).
 *
 * Prerequisite: runs/{dataset}/{gate}/pre-cascade/*.val.jsonl must exist (run
 *   pre-cascade.ts with --split val first).
 *
 * Usage:
 *   npx tsx evaluate/evaluator/runner/tune-thresholds.ts
 *   npx tsx evaluate/evaluator/runner/tune-thresholds.ts \
 *     --w-error 2.0 --w-doubt 1.0 --dataset k8,cpython --label-field adaptive_label
 *
 *   --w-error       weight for silent errors (default: 1.0)
 *   --w-doubt       weight for regret cascades (default: 2.0)
 *   --dataset       k8,cpython,vscode (comma-separated, required)
 *   --label-field   adaptive_label, complexity_label (comma-separated, default: adaptive_label)
 *   --file          only sweep files whose name (before .val.jsonl) starts with
 *                   this string (e.g. m0.3_H0.9_kw0.3_sem0.7)
 *   --margin-min    sweep start (default: 0)
 *   --margin-max    sweep end   (default: 1.0)
 *   --entropy-min   sweep start (default: 0)
 *   --entropy-max   sweep end   (default: 1.0)
 *   --step          sweep step  (default: 0.05)
 *   --top           combinations to show (default: 15)
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_W_ERROR,
  DEFAULT_W_DOUBT,
  DEFAULT_SWEEP_MARGIN_MIN,
  DEFAULT_SWEEP_MARGIN_MAX,
  DEFAULT_SWEEP_ENTROPY_MIN,
  DEFAULT_SWEEP_ENTROPY_MAX,
  DEFAULT_SWEEP_STEP,
  DEFAULT_SWEEP_TOP,
} from "../config.js";
import { gateNameFor, resolveLabelFields } from "./shared.js";

// ── Types ──

interface PreCascadeRow {
  id: string;
  truth: string;
  predicted: string;
  correct: boolean;
  margin: number;
  entropy: number;
  cascade: boolean;
  scores: Record<string, number>;
  latencyMs: number;
  kwScores?: Record<string, number>;
  semScores?: Record<string, number>;
}

interface SweepResult {
  margin: number;
  entropy: number;
  total: number;
  correct: number;
  accuracy: number;
  cascadeCount: number;
  cascadeRate: number;
  regretCascadeCount: number;
  regretCascadeRate: number;
  silentErrors: number;
  silentErrorRate: number;
  cost: number;
  datasets: string[];
}

// ── Load runs ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUNS_DIR = resolve(__dirname, "../../runs");

function findValRuns(
  datasetFilter: string[] | undefined,
  gateName: string,
  fileFilter?: string,
): Array<{ dataset: string; filePath: string; paramTag: string }> {
  const runs: Array<{ dataset: string; filePath: string; paramTag: string }> = [];
  const datasets = readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const ds of datasets) {
    if (datasetFilter && !datasetFilter.includes(ds)) continue;
    const preDir = join(RUNS_DIR, ds, gateName, "pre-cascade");
    if (!existsSync(preDir)) continue;

    const files = readdirSync(preDir).filter((f) => f.endsWith(".val.jsonl"));
    for (const file of files) {
      const paramTag = file.replace(".val.jsonl", "");
      if (fileFilter && !paramTag.startsWith(fileFilter)) continue;
      runs.push({ dataset: ds, filePath: join(preDir, file), paramTag });
    }
  }
  return runs;
}

function loadRun(filePath: string): PreCascadeRow[] {
  const raw = readFileSync(filePath, "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PreCascadeRow);
}

// ── CLI ──

function parseArgs(): Record<string, string> {
  const raw: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1]?.startsWith("--") ? "true" : argv[++i];
      raw[key] = val ?? "true";
    }
  }
  return raw;
}

// ── Sweep ──

function sweep(
  rows: PreCascadeRow[],
  datasets: string[],
  wError: number,
  wDoubt: number,
  marginMin: number,
  marginMax: number,
  entropyMin: number,
  entropyMax: number,
  step: number,
): SweepResult[] {
  const total = rows.length;

  // Pre-compute correctness + per-row confidence from the stored pre-cascade
  // blend (at its fixed kw/sem weights).
  const rowCorrect = rows.map((r) => r.correct);
  const rowMargin = rows.map((r) => r.margin);
  const rowEntropy = rows.map((r) => r.entropy);

  const results: SweepResult[] = [];

  for (let m = marginMin; m <= marginMax + step / 2; m = roundStep(m + step, step)) {
    for (let h = entropyMin; h <= entropyMax + step / 2; h = roundStep(h + step, step)) {
        let correct = 0;
        let cascadeCount = 0;
        let regretCascadeCount = 0;

        for (let i = 0; i < total; i++) {
          const wouldCascade = rowMargin[i] < m || rowEntropy[i] > h;
          if (wouldCascade) {
            cascadeCount++;
            if (rowCorrect[i]) regretCascadeCount++; // correct but cascaded = wasted LLM
          } else if (rowCorrect[i]) {
            correct++;
          }
        }

        // Silent errors = non-cascaded AND wrong.
        const silentErrors = total - cascadeCount - correct;
        const cascadeRate = cascadeCount / total;
        const regretCascadeRate = regretCascadeCount / total;
        const silentErrorRate = silentErrors / total;
        const accuracy = correct / total;
        const cost = wError * silentErrorRate + wDoubt * regretCascadeRate;

        results.push({
          margin: m,
          entropy: h,
          total,
          correct,
          accuracy,
          cascadeCount,
          cascadeRate,
          regretCascadeCount,
          regretCascadeRate,
          silentErrors,
          silentErrorRate,
          cost,
          datasets,
        });
      }
    }

  return results;
}

function roundStep(value: number, step: number): number {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  return parseFloat(value.toFixed(decimals));
}

// ── Main ──

interface SweepArgs {
  gateName: string;
  datasetFilter: string[];
  fileFilter?: string;
  wError: number;
  wDoubt: number;
  step: number;
  topN: number;
  marginMin: number;
  marginMax: number;
  entropyMin: number;
  entropyMax: number;
}

function sweepGate(args: SweepArgs) {
  const { gateName, datasetFilter, fileFilter, wError, wDoubt, step, topN, marginMin, marginMax, entropyMin, entropyMax } = args;

  const runs = findValRuns(datasetFilter, gateName, fileFilter);
  if (runs.length === 0) {
    console.log(
      fileFilter
        ? `No pre-cascade *.val.jsonl runs matching "${fileFilter}" found.`
        : "No pre-cascade *.val.jsonl runs found.",
    );
    return;
  }

  // Pool all rows across datasets
  const allRows: PreCascadeRow[] = [];
  const allDatasets: string[] = [];

  for (const { dataset, filePath } of runs) {
    const rows = loadRun(filePath);
    allRows.push(...rows);
    if (!allDatasets.includes(dataset)) allDatasets.push(dataset);
  }

  console.log(`Loaded ${allRows.length} val rows from ${runs.length} file(s) across ${allDatasets.length} dataset(s).`);
  console.log(`Datasets: ${allDatasets.join(", ")}`);
  console.log(`Weights: W_Error=${wError}  W_Doubt=${wDoubt}`);
  console.log(`Regret = (${wError} × SilentErr%) + (${wDoubt} × RegretCas%)`);

  // Sweep
  const results = sweep(
    allRows, allDatasets, wError, wDoubt,
    marginMin, marginMax, entropyMin, entropyMax, step,
  );

  // Sort by regret (ascending)
  results.sort((a, b) => a.cost - b.cost);

  // ── Print top N ──
  console.log(`Top ${Math.min(topN, results.length)} of ${results.length} combinations:\n`);
  console.log(" Rank   Margin  Entropy   Acc%    SilentErr%  RegretCas%     Cost");
  console.log("─".repeat(80));

  for (let i = 0; i < Math.min(topN, results.length); i++) {
    const r = results[i];
    const prefix = i === 0 ? "🏆" : "  ";
    console.log(
      ` ${prefix}${String(i + 1).padStart(3)}   ${r.margin.toFixed(2).padStart(5)}   ${r.entropy.toFixed(2).padStart(5)}   ${(r.accuracy * 100).toFixed(1).padStart(5)}  ${(r.silentErrorRate * 100).toFixed(1).padStart(9)}  ${(r.regretCascadeRate * 100).toFixed(1).padStart(9)}  ${r.cost.toFixed(4).padStart(8)}`,
    );
  }

  // ── Best ──
  const best = results[0];
  console.log(`\n🏆  Best: margin=${best.margin}  entropy=${best.entropy}  →  Cost = ${best.cost.toFixed(4)}`);
  console.log(`    Silent Error Rate = ${(best.silentErrorRate * 100).toFixed(1)}%  |  Regret Cascade Rate = ${(best.regretCascadeRate * 100).toFixed(1)}%`);
  console.log(`    Accuracy = ${(best.accuracy * 100).toFixed(1)}%  (pre-cascade, non-cascaded only)`);
  console.log(`    CAS_MARGIN_THRESHOLD = ${best.margin}  |  CAS_ENTROPY_THRESHOLD = ${best.entropy}`);

  // ── Pareto frontier hint ──
  console.log(`\nTo explore trade-offs, try: --w-error 2.0 --w-doubt 1.0  (penalise errors more)`);
  console.log(`                       : --w-error 1.0 --w-doubt 2.0  (penalise cascades more)`);
  console.log(`                       : --step 0.02  (finer granularity)`);
}

function main() {
  const raw = parseArgs();
  const wError = raw["w-error"] ? parseFloat(raw["w-error"]) : DEFAULT_W_ERROR;
  const wDoubt = raw["w-doubt"] ? parseFloat(raw["w-doubt"]) : DEFAULT_W_DOUBT;
  const step = raw.step ? parseFloat(raw.step) : DEFAULT_SWEEP_STEP;
  const topN = raw.top ? parseInt(raw.top, 10) : DEFAULT_SWEEP_TOP;
  const datasetFilter = raw.dataset
    ? raw.dataset.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  if (!datasetFilter || datasetFilter.length === 0) {
    console.error("Error: --dataset is required (comma-separated for multiple)");
    process.exit(1);
  }

  const fileFilter = raw.file ? raw.file.trim() : undefined;

  const marginMin = raw["margin-min"] ? parseFloat(raw["margin-min"]) : DEFAULT_SWEEP_MARGIN_MIN;
  const marginMax = raw["margin-max"] ? parseFloat(raw["margin-max"]) : DEFAULT_SWEEP_MARGIN_MAX;
  const entropyMin = raw["entropy-min"] ? parseFloat(raw["entropy-min"]) : DEFAULT_SWEEP_ENTROPY_MIN;
  const entropyMax = raw["entropy-max"] ? parseFloat(raw["entropy-max"]) : DEFAULT_SWEEP_ENTROPY_MAX;

  const labelFields = resolveLabelFields(raw);

  for (const labelField of labelFields) {
    const gateName = gateNameFor(labelField);
    console.log(`\nLabel field: ${labelField}  |  Gate: ${gateName}`);
    sweepGate({
      gateName,
      datasetFilter,
      fileFilter,
      wError,
      wDoubt,
      step,
      topN,
      marginMin,
      marginMax,
      entropyMin,
      entropyMax,
    });
  }
}

main();
