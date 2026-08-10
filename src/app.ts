import Fastify from "fastify";
import fastifyEnv from "@fastify/env";
import fastifyCors from "@fastify/cors";

const envSchema = {
  type: "object",
  required: ["DATABASE_URL", "EMBED_BASE_URL", "EMBED_MODEL"],
  properties: {
    PORT: { type: "number", default: 3000 },
    DATABASE_URL: { type: "string" },
    EMBED_BASE_URL: { type: "string" },
    EMBED_MODEL: { type: "string" },
    EMBED_DIMS: { type: "number", nullable: true },
    EMBED_API_KEY: { type: "string", nullable: true },
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
    };
  }
}

export async function buildApp() {
  const app = Fastify({ logger: true });

  // Load & validate environment
  await app.register(fastifyEnv, { schema: envSchema, dotenv: true });

  // CORS
  await app.register(fastifyCors);

  // Health check 
  app.get("/health", async () => ({ status: "ok" }));

  // 4. Domain routes (register later as you build them)
  // await app.register(gateRoutes, { prefix: "/api/gates" });
  // await app.register(routingRoutes, { prefix: "/api" });
  // await app.register(learningRoutes, { prefix: "/api/learning" });

  return app;
}
