/**
 * LiteLLM Dataset Relabeler
 *
 * Reads an existing dataset (val.jsonl + test.jsonl), sends each entry to an
 * LLM for classification into LiteLLM routing categories, and writes the
 * relabeled output alongside the original label.
 *
 * LiteLLM routing categories: code_generation, code_understanding,
 *   technical_design, analytical_reasoning, writing, factual_lookup, general.
 *
 * Prerequisite: input dataset at {input-dir}/{name}.{val,test}.jsonl
 *
 * Usage:
 *   npx tsx evaluate/dataset/build-litellm-dataset.ts \
 *     --input-dir evaluate/dataset/k8 \
 *     --out evaluate/dataset/k8-litellm \
 *     --validator-url https://api.deepseek.com/v1 \
 *     --validator-model deepseek-chat --validator-api-key sk-xxx
 *
 *   # Defaults (Ollama): --validator-url http://localhost:11434/v1
 *   #                     --validator-model qwen2.5:7b
 *
 *   --input-dir          path to source dataset directory (required)
 *   --out                path prefix for output files (required)
 *   --validator-url      LLM API base URL (default: http://localhost:11434/v1)
 *   --validator-model    LLM model (default: qwen2.5:7b)
 *   --validator-api-key  LLM API key (default: DEEPSEEK_API_KEY env var)
 *
 * Output: {out}.val.jsonl + {out}.test.jsonl
 *   { id, label, litellm_label, source, prompt }
 */

import { join } from "node:path";
import type { LlmClient } from "../../../src/lib/llm-client.js";
import {
  createValidatorClient,
  parseArgv,
  parseJsonResponse,
  readJsonl,
  sleep,
  writeJsonl,
} from "./shared.js";

// ── Constants ──

const LITELLM_LABELS = [
  "code_generation",
  "code_understanding",
  "technical_design",
  "analytical_reasoning",
  "writing",
  "factual_lookup",
  "general",
] as const;

type LitellmLabel = (typeof LITELLM_LABELS)[number];

const CLASSIFIER_SYSTEM_PROMPT = `You are an expert software engineering dataset annotator.
I will provide you with the Title and Body of a real GitHub Pull Request (PR) or Issue.

Your task is to analyze the cognitive work required and classify it into EXACTLY ONE of the following five LiteLLM routing categories:

1. "code_generation": The PR introduces net-new logic, features, functions, or significant code additions.
2. "code_understanding": The PR focuses on explaining existing codebase behavior, code review discussions, adding inline code comments to clarify logic, or investigating how a module currently works.
3. "technical_design": The PR involves architectural changes, API contract modifications, RFCs, or Kubernetes Enhancement Proposals (KEPs) regarding system design.
4. "analytical_reasoning": The PR resolves a complex bug, race condition, or edge case requiring multi-step debugging, structural refactoring, or logical tracing.
5. "writing": The PR is focused entirely on human-readable text (e.g., updating user documentation, READMEs, or translations).
6. "factual_lookup": The PR involves checking, bumping, or updating versions, dependencies, or compatibility matrices.
7. "general": The PR is minor administrative meta-work (e.g., CI/CD configuration, updating CODEOWNERS, bot commands, or simple housekeeping).

Respond strictly in valid JSON format using this schema:
{"litellm_label": "one of the 7 categories", "reason": "A one-sentence justification for why this category was chosen."}`;

interface DatasetRow {
  id: string;
  label: string;
  source: string;
  prompt: string;
}

interface RelabeledRow extends DatasetRow {
  litellm_label: string;
}

// ── Main ──

async function main() {
  const args = parseArgs();
  const client = buildLlmClient(args);

  for (const suffix of ["val", "test"] as const) {
    const inPath = join(args.inputDir, `${args.inputPrefix}.${suffix}.jsonl`);
    const outPath = join(args.out, `${args.inputPrefix}.${suffix}.jsonl`);

    const rows = readJsonl<DatasetRow>(inPath);
    console.error(`    [READ] ${suffix}: ${rows.length} rows from ${inPath}`);

    const relabeled: RelabeledRow[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      try {
        const result = await classifyWithLlm(client, row);
        relabeled.push({
          ...row,
          litellm_label: result.label,
        });
        console.error(`    ${row.id}: ${row.label} → ${result.label} — ${result.reason.slice(0, 80)}`);
      } catch (err) {
        console.error(`    ${row.id}: ❗️ LLM ERROR — ${String(err).slice(0, 100)} — falling back to "general"`);
        relabeled.push({
          ...row,
          litellm_label: "general",
        });
      }

      // Rate-limit: 500ms between calls
      if (i < rows.length - 1) {
        await sleep(500);
      }
    }

    writeJsonl(outPath, relabeled);
    console.error(`    [WROTE] ${suffix}: ${relabeled.length} rows to ${outPath}`);

    // Print distribution
    const dist: Record<string, number> = {};
    for (const r of relabeled) {
      dist[r.litellm_label] = (dist[r.litellm_label] ?? 0) + 1;
    }
    console.error(`    [DIST] ${suffix}:`, dist);
  }

  console.error("    [DONE] LiteLLM dataset relabeling complete.");
}

// ── LLM Classification ──

async function classifyWithLlm(
  client: LlmClient,
  row: DatasetRow,
  retries = 2,
): Promise<{ label: string; reason: string }> {
  const userContent = [
    `Title: ${row.prompt.split("\n")[0]}`,
    `Body: ${row.prompt.slice(0, 3000)}`,
  ].join("\n\n");

  let lastRaw = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await client.complete(
      [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      { type: "json_object" },
    );
    lastRaw = raw;

    if (!raw || raw.trim().length === 0) {
      console.error(`      ↳ retry ${attempt + 1}/${retries}: empty response`);
      if (attempt < retries) { await sleep(1000); continue; }
      throw new Error("LLM returned empty response after all retries");
    }

    try {
      const parsed = parseJsonResponse(raw);
      const label = String(parsed.litellm_label ?? "").toLowerCase().trim();
      const reason = String(parsed.reason ?? "");

      if (!LITELLM_LABELS.includes(label as LitellmLabel)) {
        console.error(`      ↳ retry ${attempt + 1}/${retries}: invalid label "${label}", raw="${raw.slice(0, 120)}"`);
        if (attempt < retries) { await sleep(1000); continue; }
        return { label: "general", reason: `Invalid label "${label}": ${reason}` };
      }

      return { label, reason };
    } catch (parseErr) {
      console.error(`      ↳ retry ${attempt + 1}/${retries}: JSON parse failed, raw="${raw.slice(0, 120)}"`);
      if (attempt < retries) { await sleep(1000); continue; }
      throw new Error(
        `JSON parse failed after all retries. Last raw: ${lastRaw.slice(0, 200)}`,
      );
    }
  }

  throw new Error("unreachable");
}

// ── LLM Client Factory ──

function buildLlmClient(args: ReturnType<typeof parseArgs>): LlmClient {
  const client = createValidatorClient(args);
  if (!client) {
    console.error("[ERROR] LLM validation is required for relabeling.");
    process.exit(1);
  }
  return client;
}

// ── Arg Parsing ──

function parseArgs() {
  const raw = parseArgv(process.argv.slice(2));

  const inputDir = raw["input-dir"];
  const out = raw.out;
  const validate = raw.validate ?? "on";
  const validatorModel = raw["validator-model"];
  const validatorUrl = raw["validator-url"];
  const validatorApiKey = raw["validator-api-key"];

  if (!inputDir || !out) {
    console.error(
      "[ERROR] Usage: npx tsx build-litellm-dataset.ts " +
      "--input-dir <dir> --out <prefix> " +
      "[--validator-url <url>] [--validator-model <model>] [--validator-api-key <key>] " +
      "[--input-prefix <name>]"
    );
    process.exit(1);
  }

  // Infer input-prefix from the last part of input-dir
  const dirName = inputDir.split("/").pop() ?? "dataset";
  const inputPrefix = raw["input-prefix"] ?? dirName;

  return { inputDir, out, validate, validatorModel, validatorUrl, validatorApiKey, inputPrefix };
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
