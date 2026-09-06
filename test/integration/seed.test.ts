import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedDefaultGates } from "../../src/gates/default-gates/seed.js";
import type { DefaultGateDef } from "../../src/gates/default-gates/service.js";
import * as gateStore from "../../src/store/gates.js";
import * as routingStore from "../../src/store/routing.js";
import { searchByGate } from "../../src/store/embeddings.js";
import {
  resetDb,
  setupTestContext,
  teardownTestContext,
  getTestDbUrl,
} from "../helpers/context.js";
import { gatewayEmbedding, type StubGateway } from "../helpers/gateway.js";

let gateway: StubGateway;

// System-gate embeddings have a NULL tenant, so any well-formed UUID matches
// the `tenant_id = $x OR tenant_id IS NULL` filter used by searchByGate.
const ANY_TENANT = "00000000-0000-0000-0000-000000000000";

beforeAll(async () => {
  gateway = await setupTestContext();
});
afterAll(async () => {
  await teardownTestContext(gateway);
});
beforeEach(async () => {
  await resetDb();
});

const dbUrl = () => getTestDbUrl();

function def(
  name: string,
  classes: Array<{ label: string; utterances: string[]; keywords?: string[] }>,
  description?: string,
): DefaultGateDef {
  return {
    name,
    description,
    config: { learningEnabled: true },
    classes: classes.map((c) => ({ ...c, keywords: c.keywords ?? [] })),
  };
}

const ab = [
  { label: "a", utterances: ["deploy a release"], keywords: ["deploy"] },
  { label: "b", utterances: ["debug a failure"], keywords: ["debug"] },
];

describe("seedDefaultGates (real database)", () => {
  it("seeds a missing gate and is idempotent on re-run", async () => {
    await seedDefaultGates([def("ops", ab)], dbUrl());

    let raw = await gateStore.getGateByName("ops");
    expect(raw).not.toBeNull();
    expect(raw!.gate.tenantId).toBeNull();
    expect(raw!.classes).toHaveLength(2);

    const hits = await searchByGate("ops", ANY_TENANT, gatewayEmbedding("deploy a release"), 5);
    expect(hits[0].label).toBe("a");

    await seedDefaultGates([def("ops", ab)], dbUrl());
    raw = await gateStore.getGateByName("ops");
    expect(raw!.classes).toHaveLength(2);
  });

  it("re-indexes a class when its utterances change", async () => {
    await seedDefaultGates([def("ops", ab)], dbUrl());

    await seedDefaultGates(
      [def("ops", [{ label: "a", utterances: ["ship a rollout"], keywords: ["deploy"] }, ab[1]])],
      dbUrl(),
    );

    const fresh = await searchByGate("ops", ANY_TENANT, gatewayEmbedding("ship a rollout"), 5);
    expect(fresh[0].label).toBe("a");

    const stale = await searchByGate("ops", ANY_TENANT, gatewayEmbedding("deploy a release"), 5);
    expect(stale.some((h) => h.content === "deploy a release")).toBe(false);
  });

  it("adds newly configured classes and deletes removed unused classes", async () => {
    await seedDefaultGates([def("ops", ab)], dbUrl());
    await seedDefaultGates(
      [def("ops", [...ab, { label: "c", utterances: ["c utterance"], keywords: ["c"] }])],
      dbUrl(),
    );

    let raw = await gateStore.getGateByName("ops");
    expect(raw!.classes.map((c) => c.label).sort()).toEqual(["a", "b", "c"]);

    await seedDefaultGates([def("ops", ab)], dbUrl());
    raw = await gateStore.getGateByName("ops");
    expect(raw!.classes.map((c) => c.label).sort()).toEqual(["a", "b"]);
  });

  it("keeps a removed class that still has usage history", async () => {
    await seedDefaultGates(
      [def("ops", [...ab, { label: "c", utterances: ["c utterance"], keywords: ["c"] }])],
      dbUrl(),
    );
    const raw = await gateStore.getGateByName("ops");
    const classC = raw!.classes.find((c) => c.label === "c")!;

    await routingStore.insertRouteEvent({
      routeId: "r-used",
      tenantId: null,
      gateId: raw!.gate.id,
      prompt: "used by history",
      predictedClassId: classC.id,
      stage: "pre-cascade",
      scores: { c: 1 },
      channel: "rest",
    });

    await seedDefaultGates([def("ops", ab)], dbUrl());
    const after = await gateStore.getGateByName("ops");
    expect(after!.classes.map((c) => c.label)).toContain("c");
  });

  it("updates gate metadata when the description changes", async () => {
    await seedDefaultGates([def("ops", ab, "initial description")], dbUrl());
    await seedDefaultGates([def("ops", ab, "updated description")], dbUrl());

    const raw = await gateStore.getGateByName("ops");
    expect(raw!.gate.description).toBe("updated description");
  });
});
