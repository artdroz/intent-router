import type { FastifyInstance, RouteGenericInterface } from "fastify";
import * as service from "./service.js";
import { createGateSchema, updateGateSchema } from "./schema.js";

interface GateParams extends RouteGenericInterface {
  Params: { name: string };
}

export async function gateRoutes(app: FastifyInstance) {
  app.post("/api/gates", async (req, reply) => {
    const input = createGateSchema.parse(req.body);
    const gate = await service.createGate(req.apiKeyId, input);
    return reply.status(201).send(gate);
  });

  app.get("/api/gates", async (req) => {
    return service.listGates(req.apiKeyId);
  });

  app.get<GateParams>("/api/gates/:name", async (req, reply) => {
    const gate = await service.getGate(req.apiKeyId, req.params.name);
    if (!gate) return reply.status(404).send({ error: "Gate not found" });
    return gate;
  });

  app.patch<GateParams>("/api/gates/:name", async (req) => {
    const input = updateGateSchema.parse(req.body);
    return service.updateGate(req.apiKeyId, req.params.name, input);
  });

  app.delete<GateParams>("/api/gates/:name", async (req, reply) => {
    await service.disableGate(req.apiKeyId, req.params.name);
    return reply.status(204).send();
  });
}
