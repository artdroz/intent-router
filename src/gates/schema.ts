import { z } from "zod";
import { GATE_MAX_CLASSES, GATE_MIN_CLASSES } from "./config.js";

export const gateConfigSchema = z.object({
  learningEnabled: z.boolean(),
});

export const addClassSchema = z.object({
  label: z.string().min(1).max(50),
  description: z.string().max(500).optional(),
  utterances: z.array(z.string().min(1).max(500)).optional(),
  keywords: z.array(z.string().min(1).max(100)).optional(),
});

export const updateClassSchema = z.object({
  label: z.string().min(1).max(50).optional(),
  description: z.string().max(500).optional(),
  utterances: z.array(z.string().min(1).max(500)).optional(),
  keywords: z.array(z.string().min(1).max(100)).optional(),
});

export const createGateSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  config: gateConfigSchema,
  classes: z
    .array(addClassSchema)
    .min(GATE_MIN_CLASSES, `Gate must have at least ${GATE_MIN_CLASSES} classes`)
    .max(GATE_MAX_CLASSES, `Gate cannot have more than ${GATE_MAX_CLASSES} classes`),
});

export const updateGateSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
  config: gateConfigSchema.optional(),
});
export type CreateGateInput = z.infer<typeof createGateSchema>;
export type UpdateGateInput = z.infer<typeof updateGateSchema>;
export type UpdateClassInput = z.infer<typeof updateClassSchema>;
export type AddClassInput = z.infer<typeof addClassSchema>;
