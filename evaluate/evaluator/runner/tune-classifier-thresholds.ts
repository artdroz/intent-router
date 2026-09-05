/**
 * Classifier threshold tuning — sweeps each classifier's internal confidence
 * gate over pooled val rows to find the thresholds that
 * minimise Routing Cost.
 *
 *   Cost = (W_Error × Silent_Error_Rate) + (W_Cas × Regret_Cascade_Rate)
 *
 * For a classifier acting as a standalone gatekeeper:
 *   - cascade        = NOT confident
 *   - silent error   = wrong AND confident  (should have cascaded)
 *   - regret cascade = correct AND cascaded (a wasted LLM call)
 *
 * The per-prompt raw scores are precomputed ONCE (keyword hits via
 * `collectHits`, semantic scores via `semanticRawScores` with cached prompt
 * embeddings), then every threshold combination is evaluated as pure math
 * — no re-inference, no re-embedding.
 *
 * Prerequisite: Postgres seeded + DATABASE_URL (the same as classifier.ts).
 *
 * Usage:
 *   npx tsx evaluate/evaluator/runner/tune-classifier-thresholds.ts \
 *     --classifier all --dataset k8,cpython,vscode --label-field adaptive_label
 *
 *   --classifier   keyword | semantic | all (required)
 *   --dataset      k8,cpython,vscode (comma-separated, required)
 *   --label-field  adaptive_label, complexity_label (comma-separated, default: adaptive_label)
 *                  multiple fields are pooled into a single combined result
 *   --w-error      weight for silent errors (default: 1.0)
 *   --w-cas        weight for each cascade (default: 1.0)
 *   --step         strength-threshold sweep step (keyword default 0.05, semantic default 0.1)
 *   --margin-step  sweep step for the margin threshold (default: 0.05)
 *   --limit        max prompts to precompute (quick iteration)
 *   --top          combinations to show (default: 15)
 */

import type { KeywordClassHits } from "../../../src/routing/classifiers/keyword.js";
import { collectHits, scoreKeywordClass } from "../../../src/routing/classifiers/keyword.js";
import { semanticRawScores } from "../../../src/routing/classifiers/semantic.js";
import type { Gate } from "../../../src/gates/types.js";
import {
  initDbAndSeedAll,
  loadConfig,
  loadDataset,
  buildGate,
  makeEmbedClient,
  resolveLabelFields,
} from "./shared.js";
import {
  DEFAULT_W_ERROR,
  DEFAULT_W_CAS,
  DEFAULT_EMBEDDING_URL,
  DEFAULT_EMBEDDING_MODEL,
} from "../config.js";
import {
  SEM_TOP_K,
  SEM_SIMILARITY_THRESHOLD,
  SEM_CONFIG_WEIGHT,
  SEM_FEEDBACK_WEIGHT,
  SEM_CONF_TOP_K,
  KW_FEEDBACK_BETA,
} from "../../../src/routing/config.js";
import { writeFileSync } from "fs";

// ── Types ──

interface KwRow {
  truth: string;
  hits: Map<string, KeywordClassHits>;
}

interface SemRow {
  truth: string;
  scores: Map<string, number>;
}

/** A val row tagged with the taxonomy gate it is evaluated against. */
interface PooledRow {
  id: string;
  label: string;
  prompt: string;
  gate: Gate;
}

interface SweepResult {
  strengthThr: number;
  marginThr: number;
  cascadeRate: number;
  regretCascadeRate: number;
  silentErrorRate: number;
  cost: number;
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

function roundStep(value: number, step: number): number {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  return parseFloat(value.toFixed(decimals));
}

// ── Precompute (run inference once per prompt) ──

async function precomputeKeyword(
  rows: PooledRow[],
  tenantId: string,
): Promise<KwRow[]> {
  const out: KwRow[] = [];
  for (const row of rows) {
    out.push({ truth: row.label, hits: await collectHits(row.prompt, row.gate, tenantId) });
  }
  return out;
}

async function precomputeSemantic(
  rows: PooledRow[],
  tenantId: string,
  embed: { embed(text: string): Promise<number[]> },
): Promise<SemRow[]> {
  const out: SemRow[] = [];
  for (const row of rows) {
    const { scores } = await semanticRawScores(
      row.prompt,
      row.gate,
      tenantId,
      embed,
      SEM_TOP_K,
      SEM_SIMILARITY_THRESHOLD,
      SEM_CONFIG_WEIGHT,
      SEM_FEEDBACK_WEIGHT,
      SEM_CONF_TOP_K,
    );
    out.push({ truth: row.label, scores });
  }
  return out;
}

// ── Evaluate (pure math over precomputed rows) ──

function evaluateKeyword(
  rows: KwRow[],
  beta: number,
  scoreThr: number,
  marginThr: number,
): { cascade: number; silent: number; regret: number } {
  let cascade = 0;
  let silent = 0;
  let regret = 0;

  for (const row of rows) {
    const scored = [...row.hits.entries()]
      .map(([label, hit]) => ({ label, score: scoreKeywordClass(hit, beta) }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];

    if (!top) {
      cascade++;
      continue;
    }

    // Strength is the normalized coverage score, matching the classifier gate.
    const strength = top.score;
    const margin = top.score - (scored[1]?.score ?? 0);
    const confident = strength >= scoreThr && margin >= marginThr;

    if (!confident) {
      cascade++;
      if (top.label === row.truth) regret++;
    } else if (top.label !== row.truth) {
      silent++;
    }
  }

  return { cascade, silent, regret };
}

function evaluateSemantic(
  rows: SemRow[],
  scoreThr: number,
  marginThr: number,
): { cascade: number; silent: number; regret: number } {
  let cascade = 0;
  let silent = 0;
  let regret = 0;

  for (const row of rows) {
    const sorted = [...row.scores.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted[0];

    if (!top) {
      cascade++;
      continue;
    }

    const topScore = top[1];
    const margin = topScore - (sorted[1]?.[1] ?? 0);
    const confident = topScore >= scoreThr && margin >= marginThr;

    if (!confident) {
      cascade++;
      if (top[0] === row.truth) regret++;
    } else if (top[0] !== row.truth) {
      silent++;
    }
  }

  return { cascade, silent, regret };
}

// ── Sweep ──

function sweepKeyword(
  rows: KwRow[],
  wError: number,
  wCas: number,
  beta: number,
  scoreMin: number,
  scoreMax: number,
  scoreStep: number,
  marginMin: number,
  marginMax: number,
  marginStep: number,
): SweepResult[] {
  const total = rows.length;
  const results: SweepResult[] = [];

  for (let s = scoreMin; s <= scoreMax + scoreStep / 2; s = roundStep(s + scoreStep, scoreStep)) {
    for (let m = marginMin; m <= marginMax + marginStep / 2; m = roundStep(m + marginStep, marginStep)) {
      const { cascade, silent, regret } = evaluateKeyword(rows, beta, s, m);
      const cascadeRate = cascade / total;
      const regretCascadeRate = regret / total;
      const silentErrorRate = silent / total;
      results.push({
        strengthThr: s,
        marginThr: m,
        cascadeRate,
        regretCascadeRate,
        silentErrorRate,
        cost: wError * silentErrorRate + wCas * regretCascadeRate,
      });
    }
  }

  return results;
}

function sweepSemantic(
  rows: SemRow[],
  wError: number,
  wCas: number,
  scoreMin: number,
  scoreMax: number,
  scoreStep: number,
  marginMin: number,
  marginMax: number,
  marginStep: number,
): SweepResult[] {
  const total = rows.length;
  const results: SweepResult[] = [];

  for (let s = scoreMin; s <= scoreMax + scoreStep / 2; s = roundStep(s + scoreStep, scoreStep)) {
    for (let m = marginMin; m <= marginMax + marginStep / 2; m = roundStep(m + marginStep, marginStep)) {
      const { cascade, silent, regret } = evaluateSemantic(rows, s, m);
      const cascadeRate = cascade / total;
      const regretCascadeRate = regret / total;
      const silentErrorRate = silent / total;
      results.push({
        strengthThr: s,
        marginThr: m,
        cascadeRate,
        regretCascadeRate,
        silentErrorRate,
        cost: wError * silentErrorRate + wCas * regretCascadeRate,
      });
    }
  }

  return results;
}

function printResults(name: string, rows: number, wError: number, wCas: number, topN: number, results: SweepResult[]) {
  results.sort((a, b) => a.cost - b.cost);

  console.log(`\nClassifier: ${name}  |  ${rows} val rows  |  W_Error=${wError}  W_Cas=${wCas}`);
  console.log(`Cost = (${wError} × SilentErr%) + (${wCas} × RegretCas%)`);
  console.log(" Rank   Strength  Margin   Cascade%  RegretCas%  SilentErr%   Cost");
  console.log("─".repeat(76));

  for (let i = 0; i < Math.min(topN, results.length); i++) {
    const r = results[i];
    const prefix = i === 0 ? "🏆" : "  ";
    console.log(
      ` ${prefix}${String(i + 1).padStart(3)}   ${r.strengthThr.toFixed(2).padStart(6)}   ${r.marginThr.toFixed(2).padStart(6)}   ${(r.cascadeRate * 100).toFixed(1).padStart(7)}  ${(r.regretCascadeRate * 100).toFixed(1).padStart(9)}  ${(r.silentErrorRate * 100).toFixed(1).padStart(9)}  ${r.cost.toFixed(4).padStart(7)}`,
    );
  }

  const best = results[0];
  console.log(`\n🏆  Best: strengthThr=${best.strengthThr}  marginThr=${best.marginThr}`);
  console.log(`    Silent Error Rate = ${(best.silentErrorRate * 100).toFixed(1)}%  |  Regret Cascade Rate = ${(best.regretCascadeRate * 100).toFixed(1)}%  |  Cost = ${best.cost.toFixed(4)}`);
}

// ── Main ──

async function main() {
  const raw = parseArgs();
  const classifier = raw.classifier ?? "all";
  const wError = raw["w-error"] ? parseFloat(raw["w-error"]) : DEFAULT_W_ERROR;
  const wCas = raw["w-cas"] ? parseFloat(raw["w-cas"]) : DEFAULT_W_CAS;
  const topN = raw.top ? parseInt(raw.top, 10) : 15;
  const limit = raw.limit ? parseInt(raw.limit, 10) : undefined;
  const labelFields = resolveLabelFields(raw);

  const datasets = raw.dataset
    ? raw.dataset.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  if (datasets.length === 0) {
    console.error("Error: --dataset is required (comma-separated for multiple)");
    process.exit(1);
  }

  const embeddingUrl = raw["embedding-url"] ?? DEFAULT_EMBEDDING_URL;
  const embeddingModel = raw["embedding-model"] ?? DEFAULT_EMBEDDING_MODEL;

  const classifiers = classifier === "all" ? ["keyword", "semantic"] : [classifier];

  // Cached embeddings so semantic precompute embeds each prompt exactly once
  // (prompt embeddings are label-agnostic, so the cache is shared across fields).
  const baseEmbed = makeEmbedClient(embeddingUrl, embeddingModel);
  const embedCache = new Map<string, number[]>();
  const cachedEmbed = {
    get dims() {
      return baseEmbed.dims;
    },
    embed: async (text: string) => {
      let e = embedCache.get(text);
      if (!e) {
        e = await baseEmbed.embed(text);
        embedCache.set(text, e);
      }
      return e;
    },
  };

  console.log(`\nLabel field${labelFields.length > 1 ? "s" : ""}: ${labelFields.join(" + ")}`);

  // One gate config per label field.  All datasets share the same taxonomy
  // config per label field, so the first dataset provides it.
  const perField = labelFields.map((lf) => {
    const config = loadConfig(datasets[0], lf);
    return { lf, config, gate: buildGate(config) };
  });

  // Seed every gate (with utterance embeddings) in a single eval tenant so
  // keyword and semantic precompute can score against all taxonomies at once.
  const ctx = await initDbAndSeedAll(
    perField.map((p) => p.config),
    { indexEmbeddings: true, embeddingUrl, embeddingModel },
  );
  const tenantId = ctx.tenantId;

  // Pool val rows across datasets and label fields into one combined set.
  // Each row carries the gate it is scored against, so a single sweep over the
  // pooled rows minimises one shared routing cost across all taxonomies.
  const gateByField = new Map(perField.map((p) => [p.lf, p.gate]));
  const rows: PooledRow[] = [];
  for (const ds of datasets) {
    for (const p of perField) {
      for (const loaded of loadDataset(ds, "val", p.lf)) {
        rows.push({
          id: loaded.id,
          label: loaded.label,
          prompt: loaded.prompt,
          gate: gateByField.get(p.lf)!,
        });
      }
    }
  }
  const limited = limit ? rows.slice(0, limit) : rows;

  for (const name of classifiers) {
    if (name === "keyword") {
      console.log(`\nPrecomputing keyword hits for ${limited.length} val rows…`);
      const kwRows = await precomputeKeyword(limited, tenantId);
      // Keyword strength is now the normalized coverage score in [0, 1].
      const scoreStep = raw.step ? parseFloat(raw.step) : 0.05;
      const marginStep = raw["margin-step"] ? parseFloat(raw["margin-step"]) : 0.05;
      const results = sweepKeyword(
        kwRows, wError, wCas, KW_FEEDBACK_BETA,
        0, 1, scoreStep,
        0, 0.5, marginStep,
      );
      printResults(name, kwRows.length, wError, wCas, topN, results);
      exportToJsonl(name, results);
    } else {
      console.log(`\nPrecomputing semantic scores for ${limited.length} val rows…`);
      const semRows = await precomputeSemantic(limited, tenantId, cachedEmbed);
      const scoreStep = raw.step ? parseFloat(raw.step) : 0.1;
      const marginStep = raw["margin-step"] ? parseFloat(raw["margin-step"]) : 0.05;
      const results = sweepSemantic(
        semRows, wError, wCas,
        0, 2, scoreStep,
        0, 0.5, marginStep,
      );
      printResults(name, semRows.length, wError, wCas, topN, results);
      exportToJsonl(name, results);
    }
  }
}

function exportToJsonl(name: string, results: SweepResult[]) {
  const filename = `${name}-sweep-results.jsonl`;
  const lines = results.map(r => JSON.stringify({
    strengthThr: r.strengthThr,
    marginThr: r.marginThr,
    cascadePercent: Number((r.cascadeRate * 100).toFixed(2)),
    regretCasPercent: Number((r.regretCascadeRate * 100).toFixed(2)),
    silentErrPercent: Number((r.silentErrorRate * 100).toFixed(2)),
    cost: Number(r.cost.toFixed(4))
  })).join("\n");
  
  writeFileSync(filename, lines, "utf-8");
  console.log(`\n ${name} results output to: ${filename}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
