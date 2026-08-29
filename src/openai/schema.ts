import { z } from "zod";

export const chatMessageSchema = z.object({
  role: z.string().min(1).default("user"),
  content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
});

export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
