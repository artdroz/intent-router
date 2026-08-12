import Fastify from "fastify";
import fastifyEnv from "@fastify/env";
import fastifyCors from "@fastify/cors";
import { initDb, runMigrations } from "./store/db.js";
import { authPlugin } from "./auth/plugin.js";
import { gateRoutes } from "./gates/routes.js";
import { initEmbedClient } from "./lib/embed-client.js";
import { createLlmClient } from "./lib/llm-client.js";
import { routingRoutes } from "./routing/routes.js";
import { initRouter } from "./routing/service.js";

const envSchema = {
  type: "object",
  required: ["DATABASE_URL", "EMBED_BASE_URL", "EMBED_MODEL", "LLM_BASE_URL", "LLM_MODEL"],
  properties: {
    PORT: { type: "number", default: 3000 },
    DATABASE_URL: { type: "string" },
    EMBED_BASE_URL: { type: "string" },
    EMBED_MODEL: { type: "string" },
    EMBED_DIMS: { type: "number", nullable: true },
    EMBED_API_KEY: { type: "string", nullable: true },
    LLM_BASE_URL: { type: "string" },
    LLM_MODEL: { type: "string" },
    LLM_API_KEY: { type: "string", nullable: true },
    MAX_PROMPT_LENGTH: { type: "number", default: 20000 },
  },
} as const;

declare module "fastify" {
  interface FastifyInstance {
    config: {
      PORT: number;
      DATABASE_URL: string;
      EMBED_BASE_URL: string;
      EMBED_MODEL: string;
      EMBED_DIMS?: number;
      EMBED_API_KEY?: string;
      LLM_BASE_URL: string;
      LLM_MODEL: string;
      LLM_API_KEY?: string;
      MAX_PROMPT_LENGTH: number;
    };
  }
}

export async function buildApp() {
  const app = Fastify({ logger: true });

  // Load & validate environment
  await app.register(fastifyEnv, { schema: envSchema, dotenv: true });

  // Database
  initDb(app.config.DATABASE_URL);
  await runMigrations();

  // CORS
  await app.register(fastifyCors);

  // Health check
  app.get("/health", async () => ({ status: "ok" }));

  // Auth
  await app.register(authPlugin);

  // LLM client
  const llm = createLlmClient({
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
  initRouter(llm, embed);

  // Domain routes
  await app.register(gateRoutes);
  await app.register(routingRoutes);

  return app;
}
