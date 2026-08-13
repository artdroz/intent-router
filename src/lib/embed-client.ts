const MODEL_DIMS: Record<string, number> = {
  "all-minilm": 384,
  embeddinggemma: 768,
  "nomic-embed-text": 768,
  "qwen3-embedding:0.6b": 1024,
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  "voyage-3": 1024,
  "voyage-3-lite": 512,
  "voyage-code-3": 1024,
  "text-embedding-004": 768,
  "mistral-embed": 1024,
};

export type EmbedClient = {
  embed(text: string): Promise<number[]>;
  readonly dims: number;
};

export function createEmbedClient(config: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  dims?: number;
}): EmbedClient {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  let dims = config.dims ?? MODEL_DIMS[config.model] ?? 0;

  return {
    embed: (text) =>
      callEmbeddingAPI(baseUrl, config.model, config.apiKey, text, (len) => {
        if (dims === 0) dims = len;
      }),
    get dims() {
      return dims;
    },
  };
}

/**
 * OpenAI-compatible embedding API.
 * POST /v1/embeddings  →  { data: [{ embedding: number[] }] }
 */
async function callEmbeddingAPI(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  input: string,
  onFirstCall: (dims: number) => void,
): Promise<number[]> {
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, input }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embedding HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const embedding = json.data?.[0]?.embedding;
  if (!embedding) throw new Error("Embedding response missing data[0].embedding");

  onFirstCall(embedding.length);
  return embedding;
}

// ── Singleton ────────────────────────────────────────────

let _client: EmbedClient | null = null;

export function initEmbedClient(config: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  dims?: number;
}) {
  _client = createEmbedClient(config);
  return _client;
}

export function getEmbedClient(): EmbedClient {
  if (!_client) throw new Error("Embed client not initialized — call initEmbedClient first");
  return _client;
}
