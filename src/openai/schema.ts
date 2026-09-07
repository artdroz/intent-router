import { z } from "zod";

/** A single chat message in the OpenAI-compatible request. */
export const chatMessageSchema = z.object({
  role: z.string().min(1).default("user"),
  content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
});

/** Body of `POST /v1/chat/completions`. */
export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().optional(),
});

/** Types derived from the chat-completion schemas. */
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
