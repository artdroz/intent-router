import { z } from "zod";

export const routeRequestSchema = z.object({
  prompt: z.string().min(1),
  gate: z.string().min(1).max(100),
});

export const feedbackSchema = z.object({
  routeId: z.string().min(1),
  positive: z.boolean(),
});

export type RouteRequest = z.infer<typeof routeRequestSchema>;
export type FeedbackInput = z.infer<typeof feedbackSchema>;
