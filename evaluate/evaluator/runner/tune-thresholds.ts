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
 * The full SweepResult[] surface is persisted to evaluate/runs/thresholds/ as
 * threshold-sweep_wErr{..}_wDoubt{..}_step{..}.json so it can be plotted later.
 *
 * Usage:
 *   npx tsx evaluate/evaluator/runner/tune-thresholds.ts
 *   npx tsx evaluate/evaluator/runner/tune-thresholds.ts \
 *     --w-error 2.0 --w-doubt 1.0 --dataset k8,cpython,vscode \
 *     --label-field adaptive_label,complexity_label
 *
 *   --w-error       weight for silent errors (default: 1.0)
 *   --w-doubt       weight for regret cascades (default: 2.0)
 *   --dataset       k8,cpython,vscode (comma-separated, required)
 *   --label-field   adaptive_label | complexity_label | adaptive_label,complexity_label
 *                   (comma-separated; all fields are pooled TOGETHER,
 *                   default: adaptive_label)
 *   --file          only sweep files whose name (before .val.jsonl) starts with
 *                   this string (e.g. m0.3_H0.9_kw0.3_sem0.7)
 *   --margin-min    sweep start (default: 0)
 *   --margin-max    sweep end   (default: 1.0)
 *   --entropy-min   sweep start (default: 0)
 *   --entropy-max   sweep end   (default: 1.0)
 *   --step          sweep step  (default: 0.05)
 *   --top           combinations to show (default: 15)
 */

import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
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
  RUNS_THRESHOLDS,
} from "../config.js";
import { gateNameFor } from "./shared.js";

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
  gates: string[];
  labelFields: string[];
}

// ── Load runs ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUNS_DIR = resolve(__dirname, "../../runs");
// RUNS_THRESHOLDS is repo-root-relative ("evaluate/runs/thresholds"); resolve it
// against the repo root (three levels up from this file) so cwd doesn't matter.
const THRESHOLDS_DIR = resolve(__dirname, "../../..", RUNS_THRESHOLDS);

function findValRuns(
  datasetFilter: string[] | undefined,
  gateNames: string[],
  fileFilter?: string,
): Array<{ dataset: string; gate: string; filePath: string; paramTag: string }> {
  const runs: Array<{ dataset: string; gate: string; filePath: string; paramTag: string }> = [];
  const datasets = readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const ds of datasets) {
    if (datasetFilter && !datasetFilter.includes(ds)) continue;
    for (const gate of gateNames) {
      const preDir = join(RUNS_DIR, ds, gate, "pre-cascade");
      if (!existsSync(preDir)) continue;

      const files = readdirSync(preDir).filter((f) => f.endsWith(".val.jsonl"));
      for (const file of files) {
        const paramTag = file.replace(".val.jsonl", "");
        if (fileFilter && !paramTag.startsWith(fileFilter)) continue;
        runs.push({ dataset: ds, gate, filePath: join(preDir, file), paramTag });
      }
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

interface SweepMeta {
  wError: number;
  wDoubt: number;
  step: number;
  marginMin: number;
  marginMax: number;
  entropyMin: number;
  entropyMax: number;
  labelFields: string[];
  gates: string[];
  datasets: string[];
  totalRows: number;
  generatedAt: string;
}

function writeToJson(results: SweepResult[], meta: SweepMeta): string {
  mkdirSync(THRESHOLDS_DIR, { recursive: true });
  const fileName = `threshold-sweep_wErr${meta.wError}_wDoubt${meta.wDoubt}_step${meta.step}.json`;
  const outPath = join(THRESHOLDS_DIR, fileName);
  writeFileSync(outPath, JSON.stringify({ meta, results }, null, 2));
  return outPath;
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
  gates: string[],
  labelFields: string[],
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
          gates,
          labelFields,
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

  // One or more label fields, pooled TOGETHER (e.g. adaptive_label,complexity_label).
  const labelFields = (raw["label-field"] || "adaptive_label")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const gateNames = labelFields.map(gateNameFor);
  const fileFilter = raw.file ? raw.file.trim() : undefined;

  const marginMin = raw["margin-min"] ? parseFloat(raw["margin-min"]) : DEFAULT_SWEEP_MARGIN_MIN;
  const marginMax = raw["margin-max"] ? parseFloat(raw["margin-max"]) : DEFAULT_SWEEP_MARGIN_MAX;
  const entropyMin = raw["entropy-min"] ? parseFloat(raw["entropy-min"]) : DEFAULT_SWEEP_ENTROPY_MIN;
  const entropyMax = raw["entropy-max"] ? parseFloat(raw["entropy-max"]) : DEFAULT_SWEEP_ENTROPY_MAX;

  const runs = findValRuns(datasetFilter, gateNames, fileFilter);
  if (runs.length === 0) {
    console.log(
      fileFilter
        ? `No pre-cascade *.val.jsonl runs matching "${fileFilter}" found.`
        : "No pre-cascade *.val.jsonl runs found.",
    );
    return;
  }

  // Pool all rows across datasets AND gates (label fields) together.
  const allRows: PreCascadeRow[] = [];
  const allDatasets: string[] = [];
  const allGates: string[] = [];

  for (const { dataset, gate, filePath } of runs) {
    const rows = loadRun(filePath);
    allRows.push(...rows);
    if (!allDatasets.includes(dataset)) allDatasets.push(dataset);
    if (!allGates.includes(gate)) allGates.push(gate);
  }

  console.log(`Loaded ${allRows.length} val rows from ${runs.length} file(s) across ${allDatasets.length} dataset(s) and ${allGates.length} gate(s).`);
  console.log(`Datasets: ${allDatasets.join(", ")}`);
  console.log(`Gates: ${allGates.join(", ")}`);
  console.log(`Weights: W_Error=${wError}  W_Doubt=${wDoubt}`);
  console.log(`Regret = (${wError} × SilentErr%) + (${wDoubt} × RegretCas%)`);

  // Sweep
  const results = sweep(
    allRows, allDatasets, allGates, labelFields, wError, wDoubt,
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

  // ── Persist the full sweep surface for plotting ──
  const outPath = writeToJson(results, {
    wError,
    wDoubt,
    step,
    marginMin,
    marginMax,
    entropyMin,
    entropyMax,
    labelFields,
    gates: allGates,
    datasets: allDatasets,
    totalRows: allRows.length,
    generatedAt: new Date().toISOString(),
  });
  console.log(`\nSweep surface written to ${outPath}`);

  // ── Pareto frontier hint ──
  console.log(`\nTo explore trade-offs, try: --w-error 2.0 --w-doubt 1.0  (penalise errors more)`);
  console.log(`                       : --w-error 1.0 --w-doubt 2.0  (penalise cascades more)`);
  console.log(`                       : --step 0.02  (finer granularity)`);
}

main();
