import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { getDb } from "../store/db.js";
import { apiKeys } from "../store/schema.js";
import { eq } from "drizzle-orm";

declare module "fastify" {
  interface FastifyRequest {
    apiKeyId: number;
  }
}

// `fp` breaks encapsulation so the onRequest hook and request decoration apply
// to every route registered after this plugin (i.e. the actual API routes).
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest("apiKeyId", 0);

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Missing API key" });
    }

    const key = header.slice(7);
    const hash = createHash("sha256").update(key).digest("hex");

    const db = getDb();
    const [row] = await db
      .select({ id: apiKeys.id, enabled: apiKeys.enabled, expiresAt: apiKeys.expiresAt })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hash));

    if (!row) {
      return reply.status(401).send({ error: "Invalid API key" });
    }
    if (!row.enabled) {
      return reply.status(401).send({ error: "API key disabled" });
    }
    if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
      return reply.status(401).send({ error: "API key expired" });
    }

    req.apiKeyId = row.id;
  });
});
