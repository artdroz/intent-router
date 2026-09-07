/**
 * Shared helpers for the evaluate/dataset scripts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { initLlmClient, type LlmClient } from "../../src/clients/llm-client.js";

export const DEFAULT_VALIDATOR_URL = "http://localhost:11434/v1";
export const DEFAULT_VALIDATOR_MODEL = "qwen2.5:7b";

/** Parse a JSON response from an LLM, handling markdown fences and other noise. */
export function parseJsonResponse(text: string): Record<string, unknown> {
  // Strip ```json fences
  let cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // If the model wrapped the JSON in extra text, try to extract the first {...}
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(cleaned) as Record<string, unknown>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse `--flag value` pairs into a Record; bare flags become "true". */
export function parseArgv(argv: string[]): Record<string, string> {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1]?.startsWith("--") ? "true" : argv[++i];
      raw[key] = val ?? "true";
    }
  }
  return raw;
}

/** Read a JSONL file into an array of typed rows (empty array if missing). */
export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

/** Write an array of rows to a JSONL file, creating parent directories. */
export function writeJsonl(path: string, rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const content = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, content, "utf-8");
}

/** Strip a trailing "/v1" since createLlmClient appends "/v1/chat/completions". */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

/** Build an OpenAI-compatible validator client from validator args, or null if disabled. */
export function createValidatorClient(args: {
  validate?: string;
  validatorUrl?: string;
  validatorModel?: string;
  validatorApiKey?: string;
}): LlmClient | null {
  const mode = args.validate ?? "on";
  if (mode === "off" || mode === "false") return null;

  const baseUrl = normalizeBaseUrl(args.validatorUrl ?? DEFAULT_VALIDATOR_URL);
  const model = args.validatorModel ?? DEFAULT_VALIDATOR_MODEL;
  const apiKey = args.validatorApiKey ?? process.env.DEEPSEEK_API_KEY ?? "";

  return initLlmClient({ baseUrl, model, apiKey });
}
