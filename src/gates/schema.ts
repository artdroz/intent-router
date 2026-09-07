import { z } from "zod";

/** Minimum number of classes a gate must define. */
export const GATE_MIN_CLASSES = 2;

/** Maximum number of classes a gate may define. */
export const GATE_MAX_CLASSES = 50;

/** Maximum length of a class description (stored metadata, not used for routing). */
export const CLASS_MAX_DESCRIPTION = 500;

/** Maximum length of a gate description (stored metadata, not used for routing). */
export const GATE_MAX_DESCRIPTION = 500;

/** Per-gate routing configuration; `learningEnabled` gates the read side of online learning. */
export const gateConfigSchema = z.object({
  learningEnabled: z.boolean(),
});

/** A class definition shared by create and add operations. */
export const addClassSchema = z.object({
  label: z.string().min(1).max(50),
  description: z.string().max(CLASS_MAX_DESCRIPTION).optional(),
  utterances: z.array(z.string().min(1).max(500)).optional(),
  keywords: z.array(z.string().min(1).max(100)).optional(),
});

/** A class patch; every field is optional so partial updates are allowed. */
export const updateClassSchema = z.object({
  label: z.string().min(1).max(50).optional(),
  description: z.string().max(CLASS_MAX_DESCRIPTION).optional(),
  utterances: z.array(z.string().min(1).max(500)).optional(),
  keywords: z.array(z.string().min(1).max(100)).optional(),
});

/** Body of `POST /api/gates`. */
export const createGateSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(GATE_MAX_DESCRIPTION).optional(),
  config: gateConfigSchema,
  classes: z
    .array(addClassSchema)
    .min(GATE_MIN_CLASSES, `Gate must have at least ${GATE_MIN_CLASSES} classes`)
    .max(GATE_MAX_CLASSES, `Gate cannot have more than ${GATE_MAX_CLASSES} classes`),
});

/** Body of `PATCH /api/gates/:name`. */
export const updateGateSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(GATE_MAX_DESCRIPTION).optional(),
  config: gateConfigSchema.optional(),
});

/** Input types derived from the schemas above. */
export type CreateGateInput = z.infer<typeof createGateSchema>;
export type UpdateGateInput = z.infer<typeof updateGateSchema>;
export type UpdateClassInput = z.infer<typeof updateClassSchema>;
export type AddClassInput = z.infer<typeof addClassSchema>;
