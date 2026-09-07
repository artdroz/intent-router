import type { FastifyInstance } from "fastify";
import * as service from "./service.js";
import { routeRequestSchema, feedbackSchema } from "./schema.js";

/** REST endpoints for routing (`/api/route`) and feedback (`/api/feedback`). */
export function routingRoutes(app: FastifyInstance) {
  app.post("/api/route", async (req) => {
    const input = routeRequestSchema.parse(req.body);
    const { routeId, result } = await service.route(req.tenantId, input, "rest");
    return { routeId, ...result };
  });

  app.post("/api/feedback", async (req, reply) => {
    const input = feedbackSchema.parse(req.body);
    await service.submitFeedback(input, req.tenantId);
    return reply.status(204).send();
  });
}
