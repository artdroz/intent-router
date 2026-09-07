import { sanitizeForProxy } from "../routing/utils.js";
import { InternalError, UpstreamError } from "../errors.js";

/** Known embedding models and their output dimensions, used when dims are not configured. */
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

/** Client for the upstream embedding endpoint. */
export type EmbedClient = {
  /** Embed a single text into a vector. */
  embed(text: string): Promise<number[]>;
  /** Vector dimension, resolved from config or the first response. */
  readonly dims: number;
};

/** Build an embeddings client bound to one upstream model endpoint. */
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

/** Hard timeout on the upstream embedding call, so a hung proxy cannot hang a request. */
const EMBED_TIMEOUT_MS = 10_000;

/**
 * OpenAI-compatible embedding API.
 * POST /v1/embeddings → { data: [{ embedding: number[] }] }
 */
async function callEmbeddingAPI(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  input: string,
  onFirstCall: (dims: number) => void,
): Promise<number[]> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, input: sanitizeForProxy(input) }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
  } catch (err) {
    throw new UpstreamError(
      `Embedding request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new UpstreamError(`Embedding HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const embedding = json.data?.[0]?.embedding;
  if (!embedding) throw new UpstreamError("Embedding response missing data[0].embedding");

  onFirstCall(embedding.length);
  return embedding;
}

// Process-wide singleton, initialized at bootstrap.
let client: EmbedClient | null = null;

/** Initialize the process-wide embeddings client (called once at bootstrap). */
export function initEmbedClient(config: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  dims?: number;
}) {
  client = createEmbedClient(config);
  return client;
}

/** Return the initialized embeddings client, or throw if `initEmbedClient` has not run. */
export function getEmbedClient(): EmbedClient {
  if (!client) throw new InternalError("Embed client not initialized — call initEmbedClient first");
  return client;
}
