/**
 * Merged GitHub Dataset Builder, LiteLLM Relabeler & Error Retry
 * Fetches all GitHub issues/PRs, cleans the content, classifies them into LiteLLM routing categories,
 * automatically retries errors in-memory, and writes JSONL dataset splits.
 *
 * Usage:
 *   npx tsx evaluate/dataset/build-merged-dataset.ts \
 *     --repo microsoft/vscode --type issue --out dataset/vscode \
 *     --validator-url https://api.deepseek.com/v1 \
 *     --validator-model deepseek-chat \
 *     --validator-api-key sk-xxx
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { LlmClient } from "../../src/lib/llm-client.js";
import {
  createValidatorClient,
  parseArgv,
  parseJsonResponse,
  readJsonl,
  sleep,
} from "./shared.js";

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "config.json");

// --- Constants ---
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const MAX_PAGES = 20;
const MAX_RETRY_PASSES = 10;
const BASE_RETRY_DELAY_MS = 1500;
const MAX_RETRY_DELAY_MS = 30000;
const PAGE_SIZE = 50;
const GITHUB_EPOCH = "2008-01-01";
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const LITELLM_LABELS = [
  "code_generation",
  "code_understanding",
  "technical_design",
  "analytical_reasoning",
  "writing",
  "factual_lookup",
  "general",
] as const;

type LitellmLabel = (typeof LITELLM_LABELS)[number] | "confused";

const COMPLEXITY_LABELS = ["simple", "medium", "complex", "reasoning"] as const;

type ComplexityLabel = (typeof COMPLEXITY_LABELS)[number] | "confused";

function isAdaptiveLabel(value: string): value is LitellmLabel {
  return value === "confused" || (LITELLM_LABELS as readonly string[]).includes(value);
}

function isComplexityLabel(value: string): value is ComplexityLabel {
  return value === "confused" || (COMPLEXITY_LABELS as readonly string[]).includes(value);
}

function getRetryDelayMs(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1));
}

function isRetryableNetworkError(err: unknown): boolean {
  const message = String(err).toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("eai_again") ||
    message.includes("socket hang up") ||
    message.includes("429") ||
    message.includes("503")
  );
}

function quotaKey(repo: string, ghLabel: string): string {
  return `${repo}::${ghLabel}`;
}

const CLASSIFIER_SYSTEM_PROMPT = `You are an expert request classifier and dataset annotator for an LLM router system.
Your task is to classify the user's request by determining its primary intent and its complexity tier.

**Part 1: Primary Intent** (adaptive_label)
Classify the primary intent requested into EXACTLY ONE of these seven labels:
- "code_generation": Write, create, implement, or build code, scripts, functions, or APIs.
- "code_understanding": Explain, review, debug, fix, or trace existing code, bugs, or stack traces.
- "technical_design": Architect, model, or structure a system, infrastructure, database, or compare technical trade-offs.
- "analytical_reasoning": Solve, compute, prove, or reason through math, logic, complex debugging, edge-case analysis, or problems requiring multi-step technical reasoning.
- "writing": Draft, edit, rewrite, or translate prose, emails, essays, or documentation.
- "factual_lookup": Direct factual questions, definitions, or simple attributes.
- "general": Catch-all for configuration, general announcements, admin tasks, greetings, or when no specific category applies.

If you cannot confidently pick exactly one category, output "confused" for adaptive_label.

**Part 2: Complexity Tier** (complexity_label)
Classify the reasoning and execution difficulty into EXACTLY ONE tier. You MUST evaluate the request using a two-dimensional cognitive and structural matrix:
- Dimension A (Reasoning Depth): The number of logical hops, deductive steps, or required hypothesis-verification cycles to find a solution.
- Dimension B (Execution Scope): The volume of files, integrations, structural breadth, or semantic distance between necessary components.

Base your classification strictly on the following rigorous boundaries:
- "simple": (Low Depth, Low Scope)
	- Characteristics: Single-step execution. Direct parameter/pattern matching. Recall of explicit factual knowledge.
	- Examples: Greetings, trivial code syntax corrections (e.g., fixing a small bug, updating a CSS hex code), direct API glossary lookups, answering general questions, or updating documents.
	- Cognitive Load: Minimal intrinsic load. No structural synthesis required.
- "medium": (Moderate Depth, Low/Moderate Scope)
	- Characteristics: Standard engineering tasks requiring single-step logic. The solution requires synthesis, but the root cause, target file, or required action is EXPLICITLY stated in the prompt or error log.
	- Examples: Writing a function based on explicit requirements, localised refactoring within small number of files, or resolving exceptions where the exact line number and fault mechanism are evident and no need of root cause analysis.
	- Cognitive Load: Requires application of existing knowledge schemas, but the path from problem to solution is linear.
- "complex": (Low/Moderate Depth, High Scope)
	- Characteristics: High execution effort, low deductive ambiguity. The path to the solution is KNOWN and DETERMINISTIC, but implementing it requires heavy lifting across a wide semantic distance or dependency graph
	- Examples: Migrating a database schema across multiple features/services, generating boilerplate for a full CRUD epic from a detailed specification, executing a mechanical refactor or fixing a issue across 10+ files.
	- Key Boundary: If the task requires managing a massive scope but DOES NOT require acting like a detective to discover the solution path, it is "complex".
- "reasoning": (High Depth, Any Scope)
	- Characteristics: High deductive ambiguity, multi-step logic. The path to the solution is UNKNOWN, NON-LINEAR, or requires forming hypotheses, evaluating trade-offs, or navigating extensive extraneous noise.
	- Examples: Tracing race conditions, resolving memory leaks, designing novel algorithms, resolving contradictory architectural constraints, step-by-step deduction from fragmented clues, or identifying a root cause hidden within massive, unstructured log dumps.
	- Cognitive Load: Extremely high germane and intrinsic load. Requires Chain-of-Thought, self-correction, or deep type-system reasoning.

Critical Decision Tree and Rules
1. If a task requires BOTH massive execution scope AND high multi-hop reasoning, classify it as "reasoning". Reasoning depth mathematically overrides execution scope in routing economics.
2. Not all bugs are "reasoning". If an error message explicitly points to the exact fault (e.g., "SyntaxError: expected } at line 42") which is the root cause, it is "medium". If the prompt states "App randomly crashes in production" or the error message does not reflects the root cause, it is "reasoning".
3. Do not judge by raw word count alone, but DO evaluate the signal-to-noise ratio. A short prompt requiring deep deduction is "reasoning". A massive prompt containing thousands of lines of unstructured logs where the model must filter out extraneous noise to find a single clue is ALSO "reasoning" due to high extraneous cognitive load.

If, after rigorously applying this decision tree, the required difficulty remains mathematically contradictory or genuinely underspecified, output "confused" for complexity_label.

Return strictly valid JSON:
{"adaptive_label":"one of the 7 labels or confused", "complexity_label":"one of the 4 complexity tiers or confused", "reason":"Exactly one sentence explaining the deductive reasoning for both classifications based on Scope and Depth."}`;

// --- Interfaces ---
interface PrItem {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  html_url: string;
}

interface FinalRow {
  id: string;
  source: string;
  source_label: string;
  adaptive_label: string;
  complexity_label: string;
  original_label: string;
  prompt: string;
  reasoning: string;
}

interface RepoConfig {
  repo: string;
  labels: string[];
}

interface Quota {
  key: string;
  repo: string;
  ghLabel: string;
  valHave: number;
  testHave: number;
}

interface ClassificationResult {
  adaptive_label: LitellmLabel;
  complexity_label: ComplexityLabel;
  reason: string;
}

// --- Main ---
async function main() {
  const args = parseArgs();
  const client = buildLlmClient(args);
  const repos = loadRepoConfig(args.repo);

  const valPath = `${args.out}.val.jsonl`;
  const testPath = `${args.out}.test.jsonl`;

  const quotas: Quota[] = [];
  for (const { repo, labels } of repos) {
    for (const ghLabel of labels) {
      quotas.push({ key: quotaKey(repo, ghLabel), repo, ghLabel, valHave: 0, testHave: 0 });
    }
  }

  const seen = new Set<string>();
  let globalIdCounter = 0;
  const valCounts = new Map<string, number>();
  const testCounts = new Map<string, number>();

  for (const row of readJsonl<FinalRow>(valPath)) {
    if (row.source) seen.add(row.source);
    globalIdCounter++;
    if (row.source_label) valCounts.set(row.source_label, (valCounts.get(row.source_label) ?? 0) + 1);
  }
  for (const row of readJsonl<FinalRow>(testPath)) {
    if (row.source) seen.add(row.source);
    globalIdCounter++;
    if (row.source_label) testCounts.set(row.source_label, (testCounts.get(row.source_label) ?? 0) + 1);
  }

  for (const quota of quotas) {
    quota.valHave = valCounts.get(quota.key) ?? 0;
    quota.testHave = testCounts.get(quota.key) ?? 0;
  }

  console.error(
    `    [RESUME] Loaded ${seen.size} existing rows across val + test. ${quotas.length} label quotas.`,
  );

  for (const quota of quotas) {
    const needVal = args.valCount - quota.valHave;
    const needTest = args.testCount - quota.testHave;
    if (needVal <= 0 && needTest <= 0) {
      console.error(
        `    [SKIP] ${quota.key}: val=${quota.valHave}/${args.valCount} test=${quota.testHave}/${args.testCount} (satisfied)`,
      );
      continue;
    }

    console.error(
      `    [INFO] ${quota.key}: need val=${Math.max(0, needVal)} test=${Math.max(0, needTest)}; fetching issues...`,
    );

    let currentEndDate = Date.now();
    let currentStartDate = currentEndDate - YEAR_MS;
    let processedYears = 0;

    while (quota.valHave < args.valCount || quota.testHave < args.testCount) {
      const startDate = formatDate(currentStartDate);
      const endDate = formatDate(currentEndDate);

      processedYears++;
      if (processedYears > args.maxLookbackYears) {
        console.error(
          `    [EXHAUSTED] ${quota.key}: reached max-lookback-years=${args.maxLookbackYears}; val=${quota.valHave}/${args.valCount} test=${quota.testHave}/${args.testCount}`,
        );
        break;
      }
      if (endDate < GITHUB_EPOCH) {
        console.error(
          `    [EXHAUSTED] ${quota.key}: reached GitHub epoch (${GITHUB_EPOCH}); val=${quota.valHave}/${args.valCount} test=${quota.testHave}/${args.testCount}`,
        );
        break;
      }

      console.error(
        `    [WINDOW] ${quota.key}: year #${processedYears} (${startDate}..${endDate})`,
      );

      const candidates = await fetchItemsByLabel(
        quota.repo,
        quota.ghLabel,
        startDate,
        endDate,
        (needVal + needTest) * 3,
      );
      console.error(`    [FETCHED] ${quota.key}: ${candidates.length} candidates in ${startDate}..${endDate}`);

      for (const item of candidates) {
        if (quota.valHave >= args.valCount && quota.testHave >= args.testCount) break;

        const sourcePath = `github/${quota.repo}/issues/${item.number}`;
        if (seen.has(sourcePath)) continue;
        seen.add(sourcePath);

        const originalLabels = item.labels.map((l) => l.name);
        const originalLabelStr = originalLabels.length > 0 ? originalLabels.join(",") : "none";
        const promptText = cleanBody(item.title, item.body);
        const classificationRequest = buildClassificationRequest(promptText);
        const estimatedTokens = estimateFullPromptTokens(CLASSIFIER_SYSTEM_PROMPT, classificationRequest);

        console.error(
          `    [PROMPT] #${item.number} estimated prompt tokens=${estimatedTokens} (max-tokens=${args.maxTokens})`,
        );

        if (estimatedTokens > args.maxTokens) {
          console.error(
            `    [SKIP] #${item.number} ：estimated prompt tokens=${estimatedTokens} > max-tokens=${args.maxTokens}`,
          );
          continue;
        }

        let result: ClassificationResult;
        try {
          result = await classifyWithLlm(client, promptText);
        } catch (err) {
          console.error(`    [SKIP] #${item.number} classification failed: ${String(err).slice(0, 120)}`);
          continue;
        }

        if (result.adaptive_label === "confused" || result.complexity_label === "confused") {
          console.error(
            `    [CONFUSED] #${item.number} skipped (adaptive=${result.adaptive_label}, complexity=${result.complexity_label})`,
          );
          continue;
        }

        const isVal = quota.valHave < args.valCount;
        const targetPath = isVal ? valPath : testPath;
        globalIdCounter++;

        const finalRow: FinalRow = {
          id: String(globalIdCounter).padStart(4, "0"),
          source: sourcePath,
          source_label: quota.key,
          adaptive_label: result.adaptive_label,
          complexity_label: result.complexity_label,
          original_label: originalLabelStr,
          prompt: promptText,
          reasoning: result.reason,
        };

        appendFileSync(targetPath, JSON.stringify(finalRow) + "\n", "utf8");
        if (isVal) quota.valHave++;
        else quota.testHave++;

        console.error(
          `    [APPEND] #${item.number} -> ${isVal ? "val" : "test"} (${quota.key}: ${result.adaptive_label}, ${result.complexity_label})`,
        );

        await sleep(500);
      }

      if (quota.valHave >= args.valCount && quota.testHave >= args.testCount) {
        break;
      }

      currentEndDate = currentStartDate;
      currentStartDate = currentEndDate - YEAR_MS;
    }
  }

  console.error(`    [DONE] All quotas processed.`);
  for (const quota of quotas) {
    console.error(
      `    [SUMMARY] ${quota.key}: val=${quota.valHave}/${args.valCount} test=${quota.testHave}/${args.testCount}`,
    );
  }
  printDistribution(valPath, "Validation Set");
  printDistribution(testPath, "Test Set");
}

// --- Distribution Helper ---
function printDistribution(filePath: string, splitName: string) {
  if (!existsSync(filePath)) return;
  const rows = readJsonl<FinalRow>(filePath);
  if (rows.length === 0) return;

  const adaptiveDist = new Map<string, number>();
  const complexityDist = new Map<string, number>();

  for (const row of rows) {
    adaptiveDist.set(row.adaptive_label, (adaptiveDist.get(row.adaptive_label) ?? 0) + 1);
    complexityDist.set(row.complexity_label, (complexityDist.get(row.complexity_label) ?? 0) + 1);
  }

  console.error(`\n    ========== [DISTRIBUTION] ${splitName.toUpperCase()} (${rows.length} rows) ==========`);
  
  console.error(`    【 Adaptive Label 】`);
  
  const sortedAdaptive = [...adaptiveDist.entries()].sort((a, b) => b[1] - a[1]);
  for (const [label, count] of sortedAdaptive) {
    const pct = ((count / rows.length) * 100).toFixed(1);
    console.error(`      - ${label.padEnd(20)}: ${String(count).padStart(4)} (${pct.padStart(5)}%)`);
  }

  console.error(`\n    【 Complexity Label 】`);
  
  const sortedComplexity = [...complexityDist.entries()].sort((a, b) => b[1] - a[1]);
  for (const [label, count] of sortedComplexity) {
    const pct = ((count / rows.length) * 100).toFixed(1);
    console.error(`      - ${label.padEnd(20)}: ${String(count).padStart(4)} (${pct.padStart(5)}%)`);
  }
  console.error(`    ========================================================================`);
}

function loadRepoConfig(targetRepo?: string): RepoConfig[] {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`    [ERROR] config.json not found at ${CONFIG_PATH}`);
    process.exit(1);
  }
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { repos?: Record<string, unknown> };
  const repos = parsed.repos;
  if (!repos || typeof repos !== "object") {
    console.error("    [ERROR] config.json must contain a 'repos' object.");
    process.exit(1);
  }
  const reposObj = repos as Record<string, unknown>;
  const result: RepoConfig[] = [];
  for (const [repo, labels] of Object.entries(reposObj)) {
    if (!Array.isArray(labels)) continue;
    const cleaned = labels.map((l) => String(l).trim()).filter((l) => l.length > 0);
    if (cleaned.length > 0) result.push({ repo, labels: cleaned });
  }

  if (targetRepo) {
    const filtered = result.filter((r) => r.repo === targetRepo);
    if (filtered.length === 0) {
      console.error(
        `    [ERROR] Repository "${targetRepo}" not found in config.json. Available: ${result.map((r) => r.repo).join(", ")}`,
      );
      process.exit(1);
    }
    return filtered;
  }

  if (result.length === 0) {
    console.error("    [ERROR] config.json has no repos with labels.");
    process.exit(1);
  }
  return result;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().split("T")[0];
}

// --- Fetching Logic ---
async function fetchItemsByLabel(
  repo: string,
  ghLabel: string,
  startDate: string,
  endDate: string,
  maxResults: number,
): Promise<PrItem[]> {
  const collected: PrItem[] = [];
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "task-router-dataset-builder",
  };
  if (GITHUB_TOKEN) headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;

  let page = 1;
  while (page <= MAX_PAGES && collected.length < maxResults) {
    const q = encodeURIComponent(`repo:${repo} type:issue label:"${ghLabel}" created:${startDate}..${endDate}`);
    const url = `https://api.github.com/search/issues?q=${q}&per_page=${PAGE_SIZE}&page=${page}&sort=created&order=desc`;

    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      if (isRetryableNetworkError(err)) {
        const delayMs = getRetryDelayMs(page);
        console.error(
          `    [WARN] GitHub fetch failed (page ${page}, ${repo}/${ghLabel}): ${String(err).slice(0, 120)}; retrying in ${Math.round(delayMs / 1000)}s`,
        );
        await sleep(delayMs);
        continue;
      }
      throw err;
    }

    if (!res.ok) {
      const text = await res.text();
      console.error(`    [WARN] GitHub API HTTP ${res.status} (${repo}/${ghLabel}): ${text.slice(0, 100)}`);
      break;
    }

    const data = (await res.json()) as { items: PrItem[] };
    if (!data.items || data.items.length === 0) {
      break;
    }
    collected.push(...data.items);

    if (data.items.length < PAGE_SIZE) {
      break;
    }

    page++;
    await sleep(2000);
  }
  return collected;
}

// --- Text Cleaning ---
function cleanBody(title: string, body: string | null): string {
  if (!body) return title;
  const cleaned = body.replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned || cleaned.length < 20) return title;
  return `${title}\n\n${cleaned}`;
}

function buildClassificationRequest(promptText: string): string {
  return `${promptText}\n\nReturn only one valid JSON object with exactly these keys: adaptive_label, complexity_label, reason. Do not include Markdown, analysis, or any other text.`;
}

function estimatePromptTokens(systemPrompt: string, userPrompt: string): number {
  return Math.max(1, Math.ceil((systemPrompt.length + userPrompt.length) / 4));
}

function estimateFullPromptTokens(systemPrompt: string, classificationRequest: string): number {
  return estimatePromptTokens(systemPrompt, classificationRequest);
}

// --- LLM Classification ---
async function classifyWithLlm(
  client: LlmClient,
  promptText: string,
): Promise<ClassificationResult> {
  const classificationRequest = buildClassificationRequest(promptText);

  for (let attempt = 0; attempt < MAX_RETRY_PASSES; attempt++) {
    let raw = "";
    try {
      raw = await client.complete(
        [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: classificationRequest },
        ],
        { type: "json_object" },
      );
    } catch (err) {
      if (isRetryableNetworkError(err)) {
        await sleep(getRetryDelayMs(attempt + 1));
        continue;
      }
      throw new Error(`LLM request failed: ${String(err)}`);
    }

    if (!raw || raw.trim().length === 0) {
      await sleep(getRetryDelayMs(attempt + 1));
      continue;
    }

    try {
      const parsed = parseClassificationResponse(raw);
      const adaptive_label = String(parsed.adaptive_label ?? "").toLowerCase().trim();
      const complexity_label = String(parsed.complexity_label ?? "").toLowerCase().trim();
      const reason = String(parsed.reason ?? "");

      if (!isAdaptiveLabel(adaptive_label) || !isComplexityLabel(complexity_label)) {
        console.error(
          `      ↳ invalid labels (adaptive="${adaptive_label}", complexity="${complexity_label}"), retrying`,
        );
        await sleep(getRetryDelayMs(attempt + 1));
        continue;
      }

      return { adaptive_label, complexity_label, reason };
    } catch (parseErr) {
      console.error(`      ↳ JSON parse failed. Raw output: ${raw.slice(0, 150)}...`);
      await sleep(getRetryDelayMs(attempt + 1));
      continue;
    }
  }

  throw new Error("Classification failed after all retries");
}

function parseClassificationResponse(raw: string): Record<string, unknown> {
  const candidates = [raw.trim()];
  for (let start = 0; start < raw.length; start++) {
    if (raw[start] !== "{") continue;
    const end = raw.indexOf("}", start + 1);
    if (end !== -1) {
      candidates.push(raw.slice(start, end + 1));
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = parseJsonResponse(candidate);
      if (
        typeof parsed.adaptive_label === "string" &&
        parsed.adaptive_label.trimStart().startsWith("{")
      ) {
        try {
          const nested = parseJsonResponse(parsed.adaptive_label);
          if (nested.adaptive_label && nested.complexity_label) return nested;
        } catch {
          continue;
        }
      }
      if (parsed.adaptive_label || parsed.complexity_label) return parsed;
    } catch {
      continue;
    }
  }

  throw new Error("No valid classification JSON object found");
}

// --- Factories & Parsing ---
function buildLlmClient(args: ReturnType<typeof parseArgs>): LlmClient {
  const client = createValidatorClient({
    validate: "on",
    validatorUrl: args.validatorUrl,
    validatorModel: args.validatorModel,
    validatorApiKey: args.validatorApiKey,
  });
  if (!client) {
    console.error("[ERROR] LLM client configuration is required for relabeling.");
    process.exit(1);
  }
  return client;
}

function parseArgs() {
  const raw = parseArgv(process.argv.slice(2));
  const repo = raw.repo;
  const out = raw.out;
  const valCount = parseInt(raw["val-count"] ?? "10", 10);
  const testCount = parseInt(raw["test-count"] ?? "30", 10);
  const maxLookbackYears = parseInt(raw["max-lookback-years"] ?? "10", 10);
  const maxTokens = parseInt(raw["max-tokens"] ?? "8000", 10);
  const validatorModel = raw["validator-model"];
  const validatorUrl = raw["validator-url"];
  const validatorApiKey = raw["validator-api-key"];

  if (!out) {
    console.error(
      "[ERROR] Usage: npx tsx build-merged-datasets.ts --out <path_prefix> " +
        "[--repo <owner/repo>] [--val-count 10] [--test-count 30] [--max-lookback-years 10] [--max-tokens 8000] " +
        "[--validator-url <url>] [--validator-model <model>] [--validator-api-key <key>]",
    );
    process.exit(1);
  }
  if (!Number.isInteger(valCount) || valCount < 0 || !Number.isInteger(testCount) || testCount < 0) {
    console.error("[ERROR] --val-count and --test-count must be non-negative integers.");
    process.exit(1);
  }
  if (!Number.isInteger(maxLookbackYears) || maxLookbackYears <= 0) {
    console.error("[ERROR] --max-lookback-years must be a positive integer.");
    process.exit(1);
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    console.error("[ERROR] --max-tokens must be a positive integer.");
    process.exit(1);
  }
  return {
    repo,
    out,
    valCount,
    testCount,
    maxLookbackYears,
    maxTokens,
    validatorModel,
    validatorUrl,
    validatorApiKey,
  };
}

main().catch((err) => {
  console.error("    [FATAL]", err);
  process.exit(1);
});
