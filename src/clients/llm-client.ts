import { sanitizeForProxy } from "../routing/utils.js";
import { UpstreamError } from "../errors.js";

/** A single chat message. */
export type LlmMessage = { role: string; content: string };

/** Requested response format for the chat-completions endpoint. */
export type LlmResponseFormat =
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        strict?: boolean;
        schema: Record<string, unknown>;
      };
    };

/** Client for the upstream chat-completions endpoint. */
export type LlmClient = {
  complete(messages: LlmMessage[], responseFormat?: LlmResponseFormat): Promise<string>;
};

/** Build a chat-completions client bound to one upstream model endpoint. */
export function initLlmClient(config: {
  baseUrl: string;
  model: string;
  apiKey?: string;
}): LlmClient {
  const baseUrl = config.baseUrl.replace(/\/$/, "");

  return {
    complete: (messages, responseFormat) =>
      callChatAPI(baseUrl, config.model, config.apiKey, messages, responseFormat),
  };
}

/**
 * Hard timeout on the upstream LLM call, so a hung proxy cannot hang a request.
 */
const LLM_TIMEOUT_MS = 8_000;

/**
 * OpenAI-compatible chat completions API.
 * POST /v1/chat/completions → { choices: [{ message: { content } }] }
 */
async function callChatAPI(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  messages: LlmMessage[],
  responseFormat?: LlmResponseFormat,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => ({ ...m, content: sanitizeForProxy(m.content) })),
  };
  if (responseFormat) body.response_format = responseFormat;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new UpstreamError(
      `LLM request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new UpstreamError(`LLM HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new UpstreamError("LLM response missing choices[0].message.content");

  return content;
}
