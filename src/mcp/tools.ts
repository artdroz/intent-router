import { z } from "zod";
import type { FastMCP } from "fastmcp";
import * as routing from "../routing/service.js";
import * as gates from "../gates/service.js";
import { routeRequestSchema, feedbackSchema } from "../routing/schema.js";
import {
  createGateSchema,
  updateGateSchema,
  addClassSchema,
  updateClassSchema,
} from "../gates/schema.js";
import type { McpSession } from "./session.js";
import { NotFoundError, UnauthorizedError } from "../errors.js";

type ToolContext = { session?: McpSession | null };

// ---- Output schemas (FastMCP structured results) ----

const okSchema = z.object({ ok: z.boolean() });

const routeResultSchema = z.object({
  routeId: z.string(),
  label: z.string(),
  score: z.number(),
  stage: z.enum(["pre-cascade", "llm", "historical"]),
  scores: z.record(z.string(), z.number()),
});

const gateClassDtoSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  utterances: z.array(z.string()),
  keywords: z.array(z.string()),
});

const gateDtoSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  shared: z.boolean(),
  config: z.object({ learningEnabled: z.boolean() }),
  classes: z.array(gateClassDtoSchema),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const gateListSchema = z.object({ gates: z.array(gateDtoSchema) });

function requireTenant(context: ToolContext): string {
  const tenantId = context.session?.tenantId;
  if (!tenantId) throw new UnauthorizedError("Unauthorized");
  return tenantId;
}

/** Register the routing and gate-management tools on the MCP server. */
export function registerMcpTools(server: FastMCP<McpSession>) {
  // ---- Routing ----

  server.addTool({
    name: "route_intent",
    description:
      "Route a user prompt to the best-matching class within a configured gate, using the keyword + semantic + LLM cascade.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    parameters: routeRequestSchema,
    outputSchema: routeResultSchema,
    execute: async (args, context) => {
      const { routeId, result } = await routing.route(requireTenant(context), args, "mcp");
      return { routeId, ...result };
    },
  });

  server.addTool({
    name: "submit_feedback",
    description:
      "Submit positive/negative feedback for a previous routing decision, identified by routeId.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    parameters: feedbackSchema,
    outputSchema: okSchema,
    execute: async (args, context) => {
      await routing.submitFeedback(args, requireTenant(context));
      return { ok: true };
    },
  });

  // ---- Gates (read) ----

  server.addTool({
    name: "list_gates",
    description: "List all gates visible to the authenticated tenant.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    parameters: z.object({}),
    outputSchema: gateListSchema,
    execute: async (_args, context) => ({
      gates: await gates.listGates(requireTenant(context)),
    }),
  });

  server.addTool({
    name: "get_gate",
    description: "Get a single gate by name.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    parameters: z.object({ name: z.string().min(1) }),
    outputSchema: gateDtoSchema,
    execute: async ({ name }, context) => {
      const gate = await gates.getGate(requireTenant(context), name);
      if (!gate) throw new NotFoundError(`Gate "${name}" not found`);
      return gate;
    },
  });

  // ---- Gates (write) ----

  server.addTool({
    name: "create_gate",
    description: "Create a new gate with its classes and config.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    parameters: createGateSchema,
    outputSchema: gateDtoSchema,
    execute: async (args, context) => gates.createGate(requireTenant(context), args),
  });

  server.addTool({
    name: "update_gate",
    description: "Update a gate's name, description, or config.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    parameters: z.object({
      gate: z.string().min(1),
      patch: updateGateSchema,
    }),
    outputSchema: gateDtoSchema,
    execute: async ({ gate, patch }, context) =>
      gates.updateGate(requireTenant(context), gate, patch),
  });

  server.addTool({
    name: "disable_gate",
    description: "Disable a gate by name.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    parameters: z.object({ name: z.string().min(1) }),
    outputSchema: okSchema,
    execute: async ({ name }, context) => {
      await gates.disableGate(requireTenant(context), name);
      return { ok: true };
    },
  });

  // ---- Classes ----

  server.addTool({
    name: "add_class",
    description: "Add a class (label + utterances) to a gate.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    parameters: z.object({
      gate: z.string().min(1),
      class: addClassSchema,
    }),
    outputSchema: gateClassDtoSchema,
    execute: async ({ gate, class: input }, context) =>
      gates.addClass(requireTenant(context), gate, input),
  });

  server.addTool({
    name: "update_class",
    description: "Update a class's label, description, utterances, or keywords.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    parameters: z.object({
      gate: z.string().min(1),
      label: z.string().min(1),
      patch: updateClassSchema,
    }),
    outputSchema: gateClassDtoSchema,
    execute: async ({ gate, label, patch }, context) =>
      gates.updateClass(requireTenant(context), gate, label, patch),
  });

  server.addTool({
    name: "delete_class",
    description: "Delete a class from a gate by label.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    parameters: z.object({
      gate: z.string().min(1),
      label: z.string().min(1),
    }),
    outputSchema: okSchema,
    execute: async ({ gate, label }, context) => {
      await gates.deleteClass(requireTenant(context), gate, label);
      return { ok: true };
    },
  });
}
