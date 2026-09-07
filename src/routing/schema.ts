import { z } from "zod";

/** Body of `POST /api/route`. */
export const routeRequestSchema = z.object({
  prompt: z.string().min(1),
  gate: z.string().min(1).max(100),
});

/** Body of `POST /api/feedback`. */
export const feedbackSchema = z.object({
  routeId: z.string().min(1),
  positive: z.boolean(),
});

/** Types derived from the routing schemas. */
export type RouteRequest = z.infer<typeof routeRequestSchema>;
export type FeedbackInput = z.infer<typeof feedbackSchema>;
