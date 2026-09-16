import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getGateByName } from "../store/gates.js";
import { findOrCreateTenant, findTenantByName } from "../store/tenants.js";
import { chatCompletionRequestSchema } from "./schema.js";
import { ChatCompletionError } from "./types.js";
import { handleChatCompletion, listModels } from "./service.js";
import { openaiErrorBody, toAppError } from "../errors.js";

/** Header naming the tenant, set by the LiteLLM proxy. */
export const TENANT_HEADER = "intent-router-tenant";
/** Header carrying the shared service token, set by the LiteLLM proxy. */
export const ROUTER_TOKEN_HEADER = "intent-router-token";

/** OpenAI-compatible surface: `/v1/models`, `/v1/chat/completions`, and a token-only gate introspection route. */
export function openaiRoutes(app: FastifyInstance, defaultModels: Record<string, string>) {
  app.decorateRequest("tenantId", "");

  // LiteLLM proxy vouches for the tenant. Every route requires the shared token;
  // the tenant header is required everywhere except the gate introspection route.
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!serviceTokenMatches(req)) {
      return reply
        .status(401)
        .send(openaiError(401, "authentication_error", "Invalid service token"));
    }
    if (isGateIntrospection(req)) return;

    const tenantName = req.headers[TENANT_HEADER];
    if (typeof tenantName !== "string" || tenantName.length === 0) {
      return reply
        .status(401)
        .send(openaiError(401, "authentication_error", `Missing "${TENANT_HEADER}" header`));
    }

    const tenant = req.server.config.AUTO_CREATE_TENANT
      ? await findOrCreateTenant(tenantName)
      : await findTenantByName(tenantName);
    if (!tenant) {
      return reply
        .status(401)
        .send(openaiError(401, "authentication_error", `Unknown tenant "${tenantName}"`));
    }

    req.tenantId = tenant.id;
  });

  // Service-level introspection used by the LiteLLM classifier plugin to verify
  // class-name consistency. Token-only (no tenant header).
  app.get<{ Params: { name: string } }>("/v1/intent-router/gates/:name/classes", async (req, reply) => {
    const raw = await getGateByName(req.params.name);
    if (!raw) {
      return reply
        .status(404)
        .send(openaiError(404, "invalid_request_error", `Gate "${req.params.name}" not found`));
    }
    return { classes: raw.classes.map((c) => c.label) };
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

function serviceTokenMatches(req: FastifyRequest): boolean {
  return req.headers[ROUTER_TOKEN_HEADER] === req.server.config.LITELLM_PROXY_TOKEN;
}

function isGateIntrospection(req: FastifyRequest): boolean {
  return req.url.startsWith("/v1/intent-router/gates/");
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
