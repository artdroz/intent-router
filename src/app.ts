import Fastify from "fastify";
import fastifyEnv from "@fastify/env";
import fastifyCors from "@fastify/cors";
import { initDb, runMigrations } from "./store/db.js";
import { authPlugin } from "./auth/plugin.js";
import { gateRoutes } from "./gates/routes.js";
import { createLlmClient } from "./lib/llm-client.js";

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

  // Domain routes
  await app.register(gateRoutes);

  // LLM client
  const llm = createLlmClient({
    baseUrl: app.config.LLM_BASE_URL,
    model: app.config.LLM_MODEL, 
    apiKey: app.config.LLM_API_KEY,
    });


  // 4. Domain routes (register later as you build them)
  // await app.register(gateRoutes, { prefix: "/api/gates" });
  // await app.register(routingRoutes, { prefix: "/api" });
  // await app.register(learningRoutes, { prefix: "/api/learning" });

  return app;
}
