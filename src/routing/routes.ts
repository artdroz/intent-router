import type { FastifyInstance } from "fastify";
import * as service from "./service.js";
import { routeRequestSchema, feedbackSchema } from "./schema.js";

export async function routingRoutes(app: FastifyInstance) {
  app.post("/api/route", async (req, reply) => {
    const input = routeRequestSchema.parse(req.body);
    const maxLen = req.server.config.MAX_PROMPT_LENGTH;
    if (input.prompt.length > maxLen) {
      return reply.status(400).send({ error: `Prompt exceeds max length of ${maxLen}` });
    }
    const { routeId, result } = await service.route(req.apiKeyId, input);
    return { routeId, ...result };
  });

  app.post("/api/feedback", async (req, reply) => {
    const input = feedbackSchema.parse(req.body);
    await service.submitFeedback(input);
    return reply.status(204).send();
  });
}
