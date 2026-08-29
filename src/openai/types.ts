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

export type ListModelsResponse = {
  object: "list";
  data: Array<{ id: string; object: "model"; created: number; owned_by: string }>;
};

