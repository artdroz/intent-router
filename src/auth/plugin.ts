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

// Scoped plugin (no `fastify-plugin`): the onRequest hook and request decoration
// apply only to routes registered inside the same encapsulated scope.
export function authPlugin(app: FastifyInstance) {
  app.decorateRequest("tenantId", "");

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const result = await verifyApiKey(req.headers.authorization);
    if (!result.ok) {
      return reply.status(401).send({ error: ERROR_MESSAGES[result.error] });
    }
    req.tenantId = result.tenantId;
  });
}
