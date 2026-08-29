import type { FastifyInstance, RouteGenericInterface } from "fastify";
import * as service from "./service.js";
import { createGateSchema, updateGateSchema, updateClassSchema, addClassSchema } from "./schema.js";

interface GateParams extends RouteGenericInterface {
  Params: { name: string };
}

interface ClassParams extends RouteGenericInterface {
  Params: { name: string; label: string };
}

export async function gateRoutes(app: FastifyInstance) {
  app.post("/api/gates", async (req, reply) => {
    const input = createGateSchema.parse(req.body);
    const gate = await service.createGate(req.tenantId, input);
    return reply.status(201).send(gate);
  });

  app.get("/api/gates", async (req) => {
    return service.listGates(req.tenantId);
  });

  app.get<GateParams>("/api/gates/:name", async (req, reply) => {
    const gate = await service.getGate(req.tenantId, req.params.name);
    if (!gate) return reply.status(404).send({ error: "Gate not found" });
    return gate;
  });

  app.patch<GateParams>("/api/gates/:name", async (req) => {
    const input = updateGateSchema.parse(req.body);
    return service.updateGate(req.tenantId, req.params.name, input);
  });

  app.delete<GateParams>("/api/gates/:name", async (req, reply) => {
    await service.disableGate(req.tenantId, req.params.name);
    return reply.status(204).send();
  });

  app.post("/api/gates/:name/classes", async (req, reply) => {
    const input = addClassSchema.parse(req.body);
    const cls = await service.addClass(req.tenantId, (req.params as { name: string }).name, input);
    return reply.status(201).send(cls);
  });

  app.patch<ClassParams>("/api/gates/:name/classes/:label", async (req) => {
    const input = updateClassSchema.parse(req.body);
    return service.updateClass(req.tenantId, req.params.name, req.params.label, input);
  });

  app.delete<ClassParams>("/api/gates/:name/classes/:label", async (req, reply) => {
    await service.deleteClass(req.tenantId, req.params.name, req.params.label);
    return reply.status(204).send();
  });
}
