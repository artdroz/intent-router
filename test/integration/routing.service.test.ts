import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { promoteKeyword, route, submitFeedback } from "../../src/routing/service.js";
import { createGate } from "../../src/gates/service.js";
import * as gateStore from "../../src/store/gates.js";
import * as routingStore from "../../src/store/routing.js";
import { insertMany, searchByGate } from "../../src/store/embeddings.js";
import { createTenant } from "../../src/store/tenants.js";
import type { TenantRow } from "../../src/store/schema.js";
import type { CreateGateInput } from "../../src/gates/schema.js";
import { resetDb, setupTestContext, teardownTestContext } from "../helpers/context.js";
import { gatewayEmbedding, type StubGateway } from "../helpers/gateway.js";

let gateway: StubGateway;
let tenant: TenantRow;

beforeAll(async () => {
  gateway = await setupTestContext();
});
afterAll(async () => {
  await teardownTestContext(gateway);
});
beforeEach(async () => {
  await resetDb();
  tenant = await createTenant("tenant-1");
  gateway.clearLlmReply();
  gateway.clearLlmRequests();
});

function opsGate(): CreateGateInput {
  return {
    name: "ops",
    config: { learningEnabled: true },
    classes: [
      {
        label: "deploy",
        keywords: ["deploy", "ship"],
        utterances: ["deploy the application to production", "ship a release"],
      },
      {
        label: "debug",
        keywords: ["debug", "fix"],
        utterances: ["debug a failing test", "trace an error"],
      },
    ],
  };
}

const seedOpsGate = () => createGate(tenant.id, opsGate());

describe("routing service (real database, stubbed gateway)", () => {
  it("routes a confident prompt through the pre-cascade without calling the LLM", async () => {
    await seedOpsGate();

    const { result } = await route(tenant.id, {
      prompt: "deploy the application to production",
      gate: "ops",
    });

    expect(result.stage).toBe("pre-cascade");
    expect(result.label).toBe("deploy");
    expect(gateway.llmRequests).toHaveLength(0);
  });

  it("escalates to the LLM fallback when the cheap classifiers are not confident", async () => {
    await seedOpsGate();
    gateway.setLlmReply("deploy");

    const { result } = await route(tenant.id, { prompt: "deploy debug", gate: "ops" });

    expect(result.stage).toBe("llm");
    expect(result.label).toBe("deploy");
    expect(gateway.llmRequests).toHaveLength(1);
  });

  it("degrades to the pre-cascade result when the LLM returns no usable label", async () => {
    await seedOpsGate();
    gateway.setLlmReply("no class label in this sentence");

    const { result } = await route(tenant.id, { prompt: "deploy debug", gate: "ops" });

    expect(gateway.llmRequests).toHaveLength(3);
    expect(result.stage).toBe("pre-cascade");
  });

  it("falls back to the most-frequent historical class when nothing is configured and the LLM fails", async () => {
    // A gate with no keywords or utterances skips the pre-cascade entirely.
    const raw = await gateStore.createGate(tenant.id, {
      name: "bare",
      config: { learningEnabled: true },
      classes: [
        { label: "a", utterances: [], keywords: [] },
        { label: "b", utterances: [], keywords: [] },
      ],
    });
    const classA = raw!.classes.find((c) => c.label === "a")!;

    await routingStore.insertRouteEvent({
      routeId: "r-hist",
      tenantId: tenant.id,
      gateId: raw!.gate.id,
      prompt: "anything",
      predictedClassId: classA.id,
      stage: "llm",
      scores: { a: 1, b: 0 },
      channel: "rest",
    });
    gateway.setLlmReply("zzzz");

    const { result } = await route(tenant.id, { prompt: "anything", gate: "bare" });

    expect(result.stage).toBe("historical");
    expect(result.label).toBe("a");
  });

  it("rejects routing against a gate the tenant cannot see", async () => {
    await expect(route(tenant.id, { prompt: "x", gate: "nope" })).rejects.toThrow(
      /Gate "nope" not found/,
    );
  });

  it("rejects a prompt that exceeds the maximum length", async () => {
    await seedOpsGate();

    await expect(route(tenant.id, { prompt: "x".repeat(50_001), gate: "ops" })).rejects.toThrow(
      /max length/,
    );
  });

  it("persists feedback and learns a positive embedding", async () => {
    await seedOpsGate();
    const { routeId, result } = await route(tenant.id, {
      prompt: "deploy the application to production",
      gate: "ops",
    });
    expect(result.label).toBe("deploy");

    await submitFeedback({ routeId, positive: true }, tenant.id);

    const event = await routingStore.getRouteByRouteId(routeId);
    expect(event).not.toBeNull();
    expect(event!.predictedClassId).not.toBeNull();

    const hits = await searchByGate(
      "ops",
      tenant.id,
      gatewayEmbedding("deploy the application to production"),
      10,
    );
    expect(hits.some((h) => h.source === "pos_feedback")).toBe(true);
  });

  it("learns a negative guardrail from confident negative feedback", async () => {
    await seedOpsGate();
    const { routeId } = await route(tenant.id, {
      prompt: "deploy the application to production",
      gate: "ops",
    });

    await submitFeedback({ routeId, positive: false }, tenant.id);

    const hits = await searchByGate(
      "ops",
      tenant.id,
      gatewayEmbedding("deploy the application to production"),
      10,
    );
    expect(hits.some((h) => h.source === "neg_feedback")).toBe(true);
  });

  it("searchByGate excludes learned embeddings when learning is disabled", async () => {
    await seedOpsGate();
    const raw = await gateStore.getGateByName("ops");
    const deploy = raw!.classes.find((c) => c.label === "deploy")!;

    await insertMany([
      {
        tenantId: tenant.id,
        classId: deploy.id,
        gateName: "ops",
        label: "deploy",
        content: "deploy the application to production",
        source: "pos_feedback",
        embedding: gatewayEmbedding("deploy the application to production"),
      },
    ]);

    const withLearned = await searchByGate(
      "ops",
      tenant.id,
      gatewayEmbedding("deploy the application to production"),
      10,
    );
    expect(withLearned.some((h) => h.source === "pos_feedback")).toBe(true);

    const configOnly = await searchByGate(
      "ops",
      tenant.id,
      gatewayEmbedding("deploy the application to production"),
      10,
      { includeLearned: false },
    );
    expect(configOnly.some((h) => h.source === "pos_feedback")).toBe(false);
    expect(configOnly.every((h) => h.source === "config")).toBe(true);
  });

  it("promotes class-specific keywords from accumulated feedback", async () => {
    await seedOpsGate();
    const raw = await gateStore.getGateByName("ops");
    const deployClass = raw!.classes.find((c) => c.label === "deploy")!;
    const debugClass = raw!.classes.find((c) => c.label === "debug")!;

    for (let i = 0; i < 25; i++) {
      const routeId = `r-deploy-${i}`;
      await routingStore.insertRouteEvent({
        routeId,
        tenantId: tenant.id,
        gateId: raw!.gate.id,
        prompt: `deploy prompt ${i}`,
        predictedClassId: deployClass.id,
        stage: "pre-cascade",
        scores: { deploy: 1, debug: 0 },
        channel: "rest",
      });
      await routingStore.insertFeedback(routeId, 1, ["deploy"]);
    }
    for (let i = 0; i < 5; i++) {
      const routeId = `r-debug-${i}`;
      await routingStore.insertRouteEvent({
        routeId,
        tenantId: tenant.id,
        gateId: raw!.gate.id,
        prompt: `debug prompt ${i}`,
        predictedClassId: debugClass.id,
        stage: "pre-cascade",
        scores: { debug: 1, deploy: 0 },
        channel: "rest",
      });
      await routingStore.insertFeedback(routeId, 1, ["debug"]);
    }

    await promoteKeyword();

    const promoted = await routingStore.getPromotedKeywords(deployClass.id, tenant.id);
    expect(promoted).toContain("deploy");
    const debugPromoted = await routingStore.getPromotedKeywords(debugClass.id, tenant.id);
    expect(debugPromoted).toContain("debug");
  });
});
