export type LlmMessage = { role: string; content: string };

/** Support json schema response formats */
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

export type LlmClient = {
  complete(messages: LlmMessage[], responseFormat?: LlmResponseFormat): Promise<string>;
};

export function createLlmClient(config: {
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
 * OpenAI-compatible chat completions API.
 * POST /v1/chat/completions  →  { choices: [{ message: { content } }] }
 */
async function callChatAPI(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  messages: LlmMessage[],
  responseFormat?: LlmResponseFormat,
): Promise<string> {
  const body: Record<string, unknown> = { model, messages };
  if (responseFormat) body.response_format = responseFormat;

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM response missing choices[0].message.content");

  return content;
}
