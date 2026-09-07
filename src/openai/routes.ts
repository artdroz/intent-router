import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { findTenantByName } from "../store/tenants.js";
import { chatCompletionRequestSchema } from "./schema.js";
import { ChatCompletionError } from "./types.js";
import { handleChatCompletion, listModels } from "./service.js";
import { openaiErrorBody, toAppError } from "../errors.js";

/** Header naming the tenant, set by the LiteLLM proxy. */
export const TENANT_HEADER = "intent-router-tenant";
/** Header carrying the shared service token, set by the LiteLLM proxy. */
export const ROUTER_TOKEN_HEADER = "intent-router-token";

/** OpenAI-compatible surface: `/v1/models` and `/v1/chat/completions`. */
export function openaiRoutes(app: FastifyInstance, defaultModels: Record<string, string>) {
  app.decorateRequest("tenantId", "");

  // LiteLLM proxy vouches for the tenant. The service only requires a shared
  // service token plus a tenant header, then map the tenant name to its id.
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.headers[ROUTER_TOKEN_HEADER];
    if (token !== req.server.config.LITELLM_PROXY_TOKEN) {
      return reply
        .status(401)
        .send(openaiError(401, "authentication_error", "Invalid service token"));
    }

    const tenantName = req.headers[TENANT_HEADER];
    if (typeof tenantName !== "string" || tenantName.length === 0) {
      return reply
        .status(401)
        .send(openaiError(401, "authentication_error", `Missing "${TENANT_HEADER}" header`));
    }

    const tenant = await findTenantByName(tenantName);
    if (!tenant) {
      return reply
        .status(401)
        .send(openaiError(401, "authentication_error", `Unknown tenant "${tenantName}"`));
    }

    req.tenantId = tenant.id;
  });

  // LiteLLM declares models in its own config. This is solely for debugging and
  // generic OpenAI clients.
  app.get("/v1/models", () => listModels(defaultModels));

  app.post("/v1/chat/completions", async (req, reply) => {
    try {
      const body = chatCompletionRequestSchema.parse(req.body);
      const response = await handleChatCompletion(req.tenantId, body, defaultModels);
      return reply.send(response);
    } catch (err) {
      const body = toOpenaiError(err);
      if (body.error.code >= 500) {
        req.log.error({ err, requestId: req.id }, body.error.message);
      }
      return reply.status(body.error.code).send(body);
    }
  });
}

function openaiError(status: number, type: string, message: string) {
  return { error: { message, type, code: status } };
}

/**
 * Format any thrown value into the OpenAI error envelope. OpenAI-specific
 * errors keep their own type; everything else goes through the shared
 * taxonomy, so the REST and OpenAI lanes agree on status codes.
 */
function toOpenaiError(err: unknown): { error: { message: string; type: string; code: number } } {
  if (err instanceof ChatCompletionError) {
    return { error: { message: err.message, type: err.type, code: err.status } };
  }
  return openaiErrorBody(toAppError(err));
}
