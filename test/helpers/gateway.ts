import Fastify, { type FastifyInstance } from "fastify";

/**
 * Deterministic vocabulary for the stub embedding model. Embeddings are
 * bag-of-words one-hot vectors over this vocabulary, so pgvector cosine
 * distance produces meaningful, reproducible results without a real model.
 */
export const GATEWAY_VOCAB = [
  "deploy",
  "ship",
  "rollout",
  "release",
  "production",
  "debug",
  "fix",
  "trace",
  "error",
  "failure",
  "test",
  "build",
  "run",
  "application",
  "service",
  "log",
  "issue",
  "report",
  "install",
  "configure",
] as const;

export const GATEWAY_DIMS = GATEWAY_VOCAB.length;

export function gatewayEmbedding(text: string): number[] {
  const tokens = new Set(text.toLowerCase().split(/\s+/));
  return GATEWAY_VOCAB.map((word) => (tokens.has(word) ? 1 : 0));
}

export type StubGateway = {
  url: string;
  server: FastifyInstance;
  setLlmReply(text: string): void;
  clearLlmReply(): void;
  clearLlmRequests(): void;
  readonly llmRequests: Array<{ model: string; messages: unknown }>;
};

/**
 * A local HTTP server implementing the OpenAI-compatible embedding and chat
 * endpoints the real clients talk to. The LLM reply is configurable per test;
 * the default contains no class label so a test can observe retry/fallback
 * behaviour without an explicit override.
 */
export async function startGateway(): Promise<StubGateway> {
  const app = Fastify({ logger: false });
  let nextLlmReply: string | null = null;
  const llmRequests: Array<{ model: string; messages: unknown }> = [];

  app.post("/v1/embeddings", async (req) => {
    const body = (req.body ?? {}) as { input?: string };
    return { data: [{ embedding: gatewayEmbedding(body.input ?? "") }] };
  });

  app.post("/v1/chat/completions", async (req) => {
    const body = (req.body ?? {}) as { model?: string; messages?: unknown };
    llmRequests.push({ model: body.model ?? "", messages: body.messages });
    return { choices: [{ message: { content: nextLlmReply ?? "llm-no-usable-label" } }] };
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as { address: string; port: number };

  return {
    url: `http://127.0.0.1:${address.port}`,
    server: app,
    setLlmReply(text: string) {
      nextLlmReply = text;
    },
    clearLlmReply() {
      nextLlmReply = null;
    },
    clearLlmRequests() {
      llmRequests.length = 0;
    },
    llmRequests,
  };
}
