import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { verifyApiKey } from "./api-keys.js";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

const ERROR_MESSAGES = {
  missing: "Missing API key",
  invalid: "Invalid API key",
  disabled: "API key disabled",
  expired: "API key expired",
} as const;

// Registered with `fastify-plugin` so the onRequest hook and the request
// decoration apply to the parent scope where the gate and routing routes are
// registered, not just to this plugin's own encapsulated context.
export const authPlugin = fp((app: FastifyInstance) => {
  app.decorateRequest("tenantId", "");

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const result = await verifyApiKey(req.headers.authorization);
    if (!result.ok) {
      return reply.status(401).send({ error: ERROR_MESSAGES[result.error] });
    }
    req.tenantId = result.tenantId;
  });
});
