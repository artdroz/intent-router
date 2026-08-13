/**
 * GitHub Dataset Builder
 *
 * Fetches GitHub issues/PRs by label, optionally validates each entry with an
 * LLM (skipping mislabeled ones), and writes JSONL dataset splits.
 *
 * Prerequisite: GITHUB_TOKEN env var or --validator-api-key for validation.
 *
 * Usage:
 *   npx tsx evaluate/dataset/build-github-dataset.ts \
 *     --repo microsoft/vscode --labels "bug=kind/bug;feature=kind/feature" \
 *     --type issue --val-count 20 --test-count 50 --out dataset/vscode
 *
 *   # With LLM validation (Ollama defaults):
 *   npx tsx evaluate/dataset/build-github-dataset.ts \
 *     --repo microsoft/vscode --labels "bug=kind/bug;feature=kind/feature" \
 *     --type issue --out dataset/vscode --validate \
 *     --validator-url http://localhost:11434/v1 --validator-model qwen2.5:7b
 *
 *   # With LLM validation (DeepSeek):
 *   npx tsx evaluate/dataset/build-github-dataset.ts \
 *     --repo microsoft/vscode --labels "bug=kind/bug;feature=kind/feature" \
 *     --type issue --out dataset/vscode --validate \
 *     --validator-url https://api.deepseek.com/v1 \
 *     --validator-model deepseek-chat --validator-api-key sk-xxx
 *
 *   --repo              GitHub owner/repo (required)
 *   --labels            class=ghLabel pairs, semicolon-separated (required)
 *   --type              issue | pr (required)
 *   --val-count         validation prompts per class (default: 20)
 *   --test-count        test prompts per class (default: 50)
 *   --out               output path prefix (required)
 *   --descriptions      class=description pairs for opaque labels
 *   --validate          enable LLM validation (flag, default: off)
 *   --validator-url     LLM API base URL (default: http://localhost:11434/v1)
 *   --validator-model   LLM model (default: qwen2.5:7b)
 *   --validator-api-key LLM API key (default: DEEPSEEK_API_KEY env var)
 *
 * Output: {out}.val.jsonl + {out}.test.jsonl
 *   { id, label, source, prompt }
 */

import type { LlmClient } from "../../src/lib/llm-client.js";
import {
  createValidatorClient,
  DEFAULT_VALIDATOR_MODEL,
  parseArgv,
  parseJsonResponse,
  readJsonl,
  sleep,
  writeJsonl,
} from "./shared.js";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

const MAX_RETRY_PAGES = 5;

const VALIDATOR_PROMPT = `You are a label auditor for GitHub issues/PRs.
Given an issue/PR title + body and its assigned label, determine whether the
content genuinely belongs to that label.

Respond with ONLY a JSON object:
{"match": true/false, "reason": "one-sentence explanation"}`;

interface PrItem {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  html_url: string;
}

interface DatasetRow {
  id: string;
  label: string;
  source: string;
  prompt: string;
}

async function main() {
  const args = parseArgs();
  const mappings = parseLabelMappings(args.labels);
  const descriptions = parseDescriptions(args.descriptions);
  const validator = buildLlm(args);
  const totalPerClass = args.valCount + args.testCount;

  const valPath = `${args.out}.val.jsonl`;
  const testPath = `${args.out}.test.jsonl`;

  // Resume: load already-completed rows and count per class
  const valRows = readJsonl<DatasetRow>(valPath);
  const testRows = readJsonl<DatasetRow>(testPath);
  const classExisting = new Map<string, number>();
  for (const r of valRows.concat(testRows)) {
    classExisting.set(r.label, (classExisting.get(r.label) ?? 0) + 1);
  }

  const allGhLabels = new Set(mappings.map((m) => m.ghLabel));

  for (const { className, ghLabel } of mappings) {
    const existing = classExisting.get(className) ?? 0;
    if (existing >= totalPerClass) {
      console.error(`    [SKIP] ${className}: already have ${existing}/${totalPerClass}, skipping`);
      continue;
    }
    const remaining = totalPerClass - existing;
    if (existing > 0) {
      console.error(`    [RESUME] ${className}: have ${existing}/${totalPerClass}, fetching ${remaining} more`);
    }

    const forbidden = new Set(allGhLabels);
    forbidden.delete(ghLabel);

    await fetchWithValidation({
      repo: args.repo,
      ghLabel,
      type: args.type,
      count: remaining,
      startPage: 1,
      className,
      validator,
      forbiddenLabels: forbidden,
      description: descriptions.get(className),
      valCount: args.valCount,
      valRows,
      testRows,
      onProgress: () => {
        writeJsonl(valPath, valRows);
        writeJsonl(testPath, testRows);
      },
    });

    const classCount = valRows.concat(testRows).filter((r) => r.label === className).length;
    const valGot = Math.min(classCount, args.valCount);
    const testGot = Math.max(0, classCount - args.valCount);
    console.error(`    [INFO] ${className} (${ghLabel}): val=${valGot} test=${testGot} ${args.type}s fetched`);
    await sleep(2000);
  }

  // Final write (idempotent — same data, just ensures consistency)
  writeJsonl(valPath, valRows);
  writeJsonl(testPath, testRows);
  console.error(`.   [DONE] val=${valRows.length} test=${testRows.length} rows written to ${args.out}.{val,test}.jsonl`);
}

/** Parse --labels into {className, ghLabel}[].
 *  "bug=kind/bug;feature=kind/feature" → [{className:"bug", ghLabel:"kind/bug"}, ...] */
function parseLabelMappings(raw: string): Array<{ className: string; ghLabel: string }> {
  if (!raw.includes("=")) {
    console.error("    [ERROR] --labels must use class=ghLabel format. Example: --labels \"bug=kind/bug;feature=kind/feature\"");
    process.exit(1);
  }
  return raw.split(";").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      console.error(`    [ERROR] invalid label mapping "${pair}" — expected class=ghLabel`);
      process.exit(1);
    }
    const className = pair.slice(0, eq).trim();
    const ghLabel = pair.slice(eq + 1).trim();
    if (!className || !ghLabel) {
      console.error(`    [ERROR] invalid label mapping "${pair}" — both class and ghLabel must be non-empty`);
      process.exit(1);
    }
    return { className, ghLabel };
  });
}

/** Parse --descriptions into Map<className, description>.
 *  "ubb=Usage-Based Billing;wsl=Windows Subsystem" → Map { ubb → "...", wsl → "..." } */
function parseDescriptions(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw || !raw.includes("=")) return map;
  for (const pair of raw.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (key && val) map.set(key, val);
  }
  return map;
}

/** Remove template sections and metadata, including any line that contains
 *  the exact GitHub label used for searching (prevents label leakage into prompt). */
function cleanBody(title: string, body: string | null, ghLabel: string): string {
  if (!body) return title;

  // Escape label for regex and build a pattern that matches lines containing it
  const escaped = ghLabel.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
  const labelRegex = new RegExp(`^.*${escaped}.*$`, "gim");

  // For k8s-style labels like "kind/bug", also strip "/kind bug" lines
  let extraRegex: RegExp | null = null;
  if (ghLabel.includes("/")) {
    const cmdForm = ghLabel.replace("/", " "); // "kind/bug" → "kind bug"
    const cmdEscaped = cmdForm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    extraRegex = new RegExp(`^.*${cmdEscaped}.*$`, "gim");
  }

  let cleaned = body
    .replace(labelRegex, "")
    .trim();

  if (extraRegex) {
    cleaned = cleaned.replace(extraRegex, "").replace(/\n{3,}/g, "\n\n").trim();
  }

  if (!cleaned || cleaned.length < 20) return title;
  return `${title}\n\n${cleaned}`;
}

/** Build LLM validator client based on command-line arguments. */
function buildLlm(
  args: ReturnType<typeof parseArgs>,
): { client: LlmClient; label: string } | null {
  const client = createValidatorClient(args);
  if (!client) return null;
  return {
    client,
    label: args.validatorModel ?? DEFAULT_VALIDATOR_MODEL,
  };
}

/** Validate whether an item belongs to a specific label using the LLM. */
async function validateWithLlm(
  client: LlmClient,
  item: PrItem,
  expectedLabel: string,
  ghLabel: string,
  description?: string,
): Promise<boolean> {
  const cleaned = cleanBody(item.title, item.body, ghLabel);
  const labelText = description
    ? `Label: ${expectedLabel} (${description})`
    : `Label: ${expectedLabel}`;
  const userPrompt = [
    labelText,
    `Title: ${item.title}`,
    `Body: ${(cleaned ?? "").slice(0, 2000)}`,
  ].join("\n");

  try {
    const raw = await client.complete(
      [
        { role: "system", content: VALIDATOR_PROMPT },
        { role: "user", content: userPrompt },
      ],
      { type: "json_object" },
    );
    const parsed = parseJsonResponse(raw);
    const match = parsed.match;
    if (!match) {
      console.error(`    [LLM] reject expected="${expectedLabel}" — ${parsed.reason ?? "no reason"} — ${item.html_url}`);
    }
    return match === true;
  } catch (err) {
    console.error(`    [LLM] error: ${String(err).slice(0, 80)} — keeping item`);
    return true;
  }
}

/** Fetch items with LLM validation and cross-contamination filtering. */
async function fetchWithValidation(opts: {
  repo: string;
  ghLabel: string;
  type: string;
  count: number;
  startPage: number;
  className: string;
  validator: { client: LlmClient; label: string } | null;
  forbiddenLabels: Set<string>;
  description?: string;
  valCount: number;
  valRows: DatasetRow[];
  testRows: DatasetRow[];
  onProgress: () => void;
}): Promise<void> {
  const { repo, ghLabel, type, count, startPage, className, validator, forbiddenLabels, description, valCount, valRows, testRows, onProgress } = opts;
  const collected: PrItem[] = [];
  const seen = new Set<number>();

  let page = startPage;
  const maxPage = startPage + MAX_RETRY_PAGES;

  if (validator) {
    console.error(`    [VALIDATE] ${className}: using ${validator.label}`);
  }

  let skippedContamination = 0;
  let skippedValidation = 0;

  while (collected.length < count && page < maxPage) {
    const candidates = await fetchItems(repo, ghLabel, type, count, page);

    for (const item of candidates) {
      if (seen.has(item.number)) continue;
      seen.add(item.number);

      // Cross-contamination: skip if this item has labels from other classes
      const itemLabelNames = new Set(item.labels.map((l) => l.name));
      const contaminatingLabels = [...itemLabelNames].filter((l) => forbiddenLabels.has(l));
      if (contaminatingLabels.length > 0) {
        skippedContamination++;
        continue;
      }

      if (validator) {
        const ok = await validateWithLlm(validator.client, item, className, ghLabel, description);
        if (!ok) {
          skippedValidation++;
          continue;
        }
        await sleep(500);
      }

      const kind = type === "issue" ? "issues" : "pull";
      const row: DatasetRow = {
        id: "", // filled below
        label: className,
        source: `github/${repo}/${kind}/${item.number}`,
        prompt: cleanBody(item.title, item.body, ghLabel),
      };

      // Split: first valCount items for this class → val, rest → test
      const classValSoFar = valRows.filter((r) => r.label === className).length;
      if (classValSoFar < valCount) {
        row.id = String(valRows.length + 1).padStart(4, "0");
        valRows.push(row);
      } else {
        row.id = String(testRows.length + 1).padStart(4, "0");
        testRows.push(row);
      }

      collected.push(item);
      onProgress();

      if (collected.length >= count) break;
    }

    page++;
    if (collected.length < count && page < maxPage) {
      await sleep(2000);
    }
  }

  if (skippedContamination > 0) {
    console.error(`    [CONTAMINATION] ${className}: skipped ${skippedContamination} items from other classes`);
  }
  if (validator && skippedValidation > 0) {
    console.error(`    [VALIDATION] ${className}: LLM rejected ${skippedValidation} mislabeled items`);
  }

  if (collected.length < count) {
    console.error(
      `[EXHAUSTED] ${className}: only got ${collected.length}/${count} after ${page - startPage} pages (max ${MAX_RETRY_PAGES}). ` +
      `Repo may not have enough ${type}s with this label.`,
    );
  }
}

/** Fetch items from the GitHub API without any validation. */
async function fetchItems(
  repo: string,
  label: string,
  type: string,
  count: number,
  page: number,
): Promise<PrItem[]> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "task-router-dataset-builder",
  };
  if (GITHUB_TOKEN) headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;

  const q = encodeURIComponent(`repo:${repo} type:${type} label:"${label}"`);
  const url = `https://api.github.com/search/issues?q=${q}&per_page=${count}&page=${page}&sort=updated&order=desc`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    console.error(`    [WARN] ${label}: HTTP ${res.status} — ${text.slice(0, 100)}`);
    return [];
  }

  const data = (await res.json()) as { items: PrItem[] };
  return data.items;
}

function parseArgs() {
  const raw = parseArgv(process.argv.slice(2));

  const repo = raw.repo;
  const labels = raw.labels;
  const type = raw.type;
  const valCount = parseInt(raw["val-count"] ?? "20", 10);
  const testCount = parseInt(raw["test-count"] ?? "50", 10);
  const out = raw.out;
  const validate = raw.validate ?? "off";
  const descriptions = raw.descriptions ?? "";
  const validatorModel = raw["validator-model"];
  const validatorUrl = raw["validator-url"];
  const validatorApiKey = raw["validator-api-key"];

  if (!repo || !labels || !type || !out) {
    console.error("   [ERROR] Usage: npx tsx build-github-dataset.ts --repo <r> --labels <l> --type <issue|pr> --out <o> [--val-count 20] [--test-count 50] [--validate] [--validator-url <url>] [--validator-model <model>] [--validator-api-key <key>]");
    process.exit(1);
  }

  return { repo, labels, type, valCount, testCount, out, validate, descriptions, validatorModel, validatorUrl, validatorApiKey };
}

main().catch((err) => {
  console.error("   [FATAL]", err);
  process.exit(1);
});

