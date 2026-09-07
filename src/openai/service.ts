import { randomUUID } from "node:crypto";
import { route } from "../routing/service.js";
import type { RouteResult } from "../routing/router/types.js";
import type { ChatCompletionRequest } from "./schema.js";
import { ChatCompletionError } from "./types.js";
import type { ChatCompletionResponse, ListModelsResponse } from "./types.js";

/** Map a chat-completion body to a routing decision and return an OpenAI-style completion. */
export async function handleChatCompletion(
  tenantId: string,
  body: ChatCompletionRequest,
  defaultModels: Record<string, string>,
): Promise<ChatCompletionResponse> {
  if (body.stream) {
    throw new ChatCompletionError(400, "invalid_request_error", "Streaming is not supported yet");
  }

  // Extract the last user message as the routing prompt
  const prompt = extractPrompt(body.messages);
  if (prompt.length === 0) {
    throw new ChatCompletionError(
      400,
      "invalid_request_error",
      "No user message found in `messages`",
    );
  }

  // The default list wins: a model present in the config maps to a system gate;
  // otherwise the model name itself is treated as a tenant-owned gate name.
  const gateName = defaultModels[body.model] ?? body.model;
  const { routeId, result } = await route(tenantId, { prompt, gate: gateName }, "litellm");

  return buildChatCompletion(body.model, routeId, result);
}

/** List the models advertised by the service (from the default-gates `models` map). */
export function listModels(defaultModels: Record<string, string>): ListModelsResponse {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: Object.keys(defaultModels).map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "intent-router",
    })),
  };
}

function buildChatCompletion(
  model: string,
  routeId: string,
  result: RouteResult,
): ChatCompletionResponse {
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify({ routeId, ...result }) },
        finish_reason: "stop",
      },
    ],
    // TODO: have the llm classifier return token usage from the upstream call
    // or estimate based on prompt length and response length
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** Extract the routing prompt: the last user message, falling back to concatenation. */
function extractPrompt(messages: ChatCompletionRequest["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const { role, content } = messages[i];
    if (role === "user" && typeof content === "string" && content.trim().length > 0) {
      return content;
    }
  }
  return messages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n")
    .trim();
}
