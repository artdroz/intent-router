/** The OpenAI-compatible chat-completion response returned by `/v1/chat/completions`. */
export type ChatCompletionResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop";
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

/** An error specific to the OpenAI-compatible surface, carrying its own `type`. */
export class ChatCompletionError extends Error {
  readonly status: number;
  readonly type: string;

  constructor(status: number, type: string, message: string) {
    super(message);
    this.name = "ChatCompletionError";
    this.status = status;
    this.type = type;
  }
}

/** The `/v1/models` listing response. */
export type ListModelsResponse = {
  object: "list";
  data: Array<{ id: string; object: "model"; created: number; owned_by: string }>;
};
