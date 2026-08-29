import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { findTenantByName } from "../store/tenants.js";
import { chatCompletionRequestSchema } from "./schema.js";
import { ChatCompletionError } from "./types.js";
import { handleChatCompletion, listModels } from "./service.js";

export const TENANT_HEADER = "intent-router-tenant";
export const ROUTER_TOKEN_HEADER = "intent-router-token";

export function openaiRoutes(app: FastifyInstance, defaultModels: Record<string, string>) {
  app.decorateRequest("tenantId", "");

  // LiteLLM proxy vouches for the tenant. The service only requires a shared
  // service token plus a tenant header, then map the tenant name to its id.
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.headers[ROUTER_TOKEN_HEADER];
    if (token !== req.server.config.LITELLM_PROXY_TOKEN) {
      return reply
        .status(401)
        .send(openaiError(401, "invalid_request_error", "Invalid service token"));
    }

    const tenantName = req.headers[TENANT_HEADER];
    if (typeof tenantName !== "string" || tenantName.length === 0) {
      return reply
        .status(401)
        .send(openaiError(401, "invalid_request_error", `Missing "${TENANT_HEADER}" header`));
    }

    const tenant = await findTenantByName(tenantName);
    if (!tenant) {
      return reply
        .status(401)
        .send(openaiError(401, "invalid_request_error", `Unknown tenant "${tenantName}"`));
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
      const { status, type, message } = toOpenaiError(err);
      return reply.status(status).send(openaiError(status, type, message));
    }
  });
}

function openaiError(status: number, type: string, message: string) {
  return { error: { message, type, code: status } };
}

function toOpenaiError(err: unknown): { status: number; type: string; message: string } {
  if (err instanceof ChatCompletionError) {
    return { status: err.status, type: err.type, message: err.message };
  }
  if (err instanceof ZodError) {
    return { status: 400, type: "invalid_request_error", message: err.message };
  }
  if (err instanceof Error) {
    if (/gate ".*" not found/i.test(err.message)) {
      return { status: 404, type: "invalid_request_error", message: err.message };
    }
    return { status: 500, type: "server_error", message: err.message };
  }
  return { status: 500, type: "server_error", message: "Unexpected error" };
}
