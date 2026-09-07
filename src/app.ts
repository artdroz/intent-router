import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fastifyEnv from "@fastify/env";
import fastifyCors from "@fastify/cors";
import { initDb } from "./store/db.js";
import { authPlugin } from "./auth/plugin.js";
import { healthRoutes } from "./health/routes.js";
import { gateRoutes } from "./gates/routes.js";
import { initEmbedClient } from "./clients/embed-client.js";
import { initLlmClient } from "./clients/llm-client.js";
import { routingRoutes } from "./routing/routes.js";
import { initRouter } from "./routing/service.js";
import { loadDefaultGatesConfig } from "./gates/default-gates/service.js";
import { seedDefaultGates } from "./gates/default-gates/seed.js";
import { openaiRoutes } from "./openai/routes.js";
import { restErrorBody, toAppError } from "./errors.js";

const envSchema = {
  type: "object",
  required: [
    "DATABASE_URL",
    "EMBED_BASE_URL",
    "EMBED_MODEL",
    "LLM_BASE_URL",
    "LLM_MODEL",
    "LITELLM_PROXY_TOKEN",
  ],
  properties: {
    PORT: { type: "number", default: 8080 },
    MCP_PORT: { type: "number", default: 8081 },
    DATABASE_URL: { type: "string" },
    EMBED_BASE_URL: { type: "string" },
    EMBED_MODEL: { type: "string" },
    EMBED_DIMS: { type: "number", nullable: true },
    EMBED_API_KEY: { type: "string", nullable: true },
    LLM_BASE_URL: { type: "string" },
    LLM_MODEL: { type: "string" },
    LLM_API_KEY: { type: "string", nullable: true },
    MAX_PROMPT_LENGTH: { type: "number", default: 50000 },
    LITELLM_PROXY_TOKEN: { type: "string" },
    DEFAULT_GATES_CONFIG_PATH: { type: "string", default: "config/default-gates.yaml" },
  },
} as const;

declare module "fastify" {
  interface FastifyInstance {
    config: {
      PORT: number;
      MCP_PORT: number;
      DATABASE_URL: string;
      EMBED_BASE_URL: string;
      EMBED_MODEL: string;
      EMBED_DIMS?: number;
      EMBED_API_KEY?: string;
      LLM_BASE_URL: string;
      LLM_MODEL: string;
      LLM_API_KEY?: string;
      MAX_PROMPT_LENGTH: number;
      LITELLM_PROXY_TOKEN: string;
      DEFAULT_GATES_CONFIG_PATH: string;
    };
  }
}

/** Build the Fastify app: env, DB, routes, router, and default-gate seeding. */
export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    genReqId: () => randomUUID(),
  });

  // Attach the request id to every response so callers can correlate logs.
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  // Load & validate environment
  await app.register(fastifyEnv, { schema: envSchema, dotenv: true });

  // Database
  initDb(app.config.DATABASE_URL);

  // CORS
  await app.register(fastifyCors);

  // Map errors to clean HTTP responses via the shared taxonomy: validation →
  // 400, missing resource → 404, conflicts → 409, upstream failures → 502,
  // anything else → 500 (logged). The OpenAI-compatible lane formats the same
  // errors into its own envelope.
  app.setErrorHandler((err, req, reply) => {
    const appError = toAppError(err);
    if (appError.statusCode >= 500) {
      req.log.error({ err, requestId: req.id }, appError.message);
    }
    return reply.status(appError.statusCode).send(restErrorBody(appError));
  });

  // Public health endpoints
  await app.register(healthRoutes);

  // LLM client
  const llm = initLlmClient({
    baseUrl: app.config.LLM_BASE_URL,
    model: app.config.LLM_MODEL,
    apiKey: app.config.LLM_API_KEY,
  });

  // Embed client
  const embed = initEmbedClient({
    baseUrl: app.config.EMBED_BASE_URL,
    model: app.config.EMBED_MODEL,
    apiKey: app.config.EMBED_API_KEY,
    dims: app.config.EMBED_DIMS,
  });

  // Routing engine (keyword + semantic + LLM cascade)
  initRouter(llm, embed, app.config.MAX_PROMPT_LENGTH);

  // Load default model->gate map + gate definitions
  const defaultGatesConfig = loadDefaultGatesConfig(app.config.DEFAULT_GATES_CONFIG_PATH);

  // Seed default gates into the DB — idempotent, safe on every startup
  await seedDefaultGates(defaultGatesConfig.gates, app.config.DATABASE_URL);

  // Lane A — API-key auth: existing REST API (and future MCP server)
  await app.register(async (api) => {
    await api.register(authPlugin);
    await api.register(gateRoutes);
    await api.register(routingRoutes);
  });

  // Lane B — LiteLLM / OpenAI-compatible surface (header-based auth)
  await app.register(openaiRoutes, defaultGatesConfig.models);

  return app;
}
