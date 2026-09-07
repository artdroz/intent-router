import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import {
  addClassSchema,
  gateConfigSchema,
  GATE_MAX_CLASSES,
  GATE_MAX_DESCRIPTION,
  GATE_MIN_CLASSES,
} from "../schema.js";

/** A single default-gate definition from the static config file. */
export const defaultGateSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(GATE_MAX_DESCRIPTION).optional(),
  config: gateConfigSchema,
  classes: z.array(addClassSchema).min(GATE_MIN_CLASSES).max(GATE_MAX_CLASSES),
});

/** The whole default config file: a model→gate map plus gate definitions. */
export const defaultGatesConfigSchema = z.object({
  models: z.record(z.string(), z.string()).default({}),
  gates: z.array(defaultGateSchema).default([]),
});

/** Types derived from the default-gate schemas. */
export type DefaultGateDef = z.infer<typeof defaultGateSchema>;
export type DefaultGatesConfig = z.infer<typeof defaultGatesConfigSchema>;

/**
 * Load the service-wide default config: a `models` map (model name -> gate name,
 * used at request time) and `gates` definitions (seeded into the DB at startup).
 */
export function loadDefaultGatesConfig(path: string): DefaultGatesConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read default gates config at "${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return defaultGatesConfigSchema.parse(parse(raw));
}
