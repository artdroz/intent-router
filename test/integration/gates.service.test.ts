import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addClass,
  createGate,
  deleteClass,
  disableGate,
  getGate,
  listGates,
  updateClass,
  updateGate,
} from "../../src/gates/service.js";
import * as gateStore from "../../src/store/gates.js";
import { searchByGate } from "../../src/store/embeddings.js";
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
});

function gateInput(
  name: string,
  classes: Array<{ label: string; keywords?: string[]; utterances?: string[] }>,
): CreateGateInput {
  return {
    name,
    config: { learningEnabled: true },
    classes: classes.map((c) => ({
      label: c.label,
      utterances: c.utterances ?? [`${c.label} default utterance`],
      keywords: c.keywords ?? [],
    })),
  };
}

const deployDebug = [
  { label: "deploy", keywords: ["deploy"], utterances: ["deploy the application to production"] },
  { label: "debug", keywords: ["debug"], utterances: ["debug a failing test"] },
];

describe("gates service (real database)", () => {
  it("persists the gate, its classes, and indexed utterance embeddings", async () => {
    const gate = await createGate(tenant.id, gateInput("ops", deployDebug));

    expect(gate.name).toBe("ops");
    expect(gate.classes.map((c) => c.label).sort()).toEqual(["debug", "deploy"]);

    const raw = await gateStore.getGateByName("ops");
    expect(raw).not.toBeNull();
    expect(raw!.classes).toHaveLength(2);

    const hits = await searchByGate(
      "ops",
      tenant.id,
      gatewayEmbedding("deploy the application to production"),
      5,
    );
    expect(hits[0].label).toBe("deploy");
  });

  it("rejects creating a gate with a duplicate name", async () => {
    await createGate(tenant.id, gateInput("ops", deployDebug));

    await expect(createGate(tenant.id, gateInput("ops", deployDebug))).rejects.toThrow(
      /already exists/,
    );
  });

  it("rejects invalid class configurations", async () => {
    await expect(createGate(tenant.id, gateInput("bad", [{ label: "only-one" }]))).rejects.toThrow(
      /at least 2 classes/,
    );

    await expect(
      createGate(
        tenant.id,
        gateInput("bad", [
          { label: "a", utterances: ["x"] },
          { label: "b", utterances: [] },
        ]),
      ),
    ).rejects.toThrow(/at least one utterance/);
  });

  it("shows a gate to its owner and system gates to everyone", async () => {
    await createGate(tenant.id, gateInput("ops", deployDebug));
    await gateStore.createGate(null, gateInput("sys", deployDebug));

    expect(await getGate(tenant.id, "ops")).not.toBeNull();
    expect(await getGate("someone-else", "ops")).toBeNull();

    expect(await getGate(tenant.id, "sys")).not.toBeNull();
    expect(await getGate("someone-else", "sys")).not.toBeNull();
  });

  it("renames a gate and keeps its classes and embeddings searchable", async () => {
    await createGate(tenant.id, gateInput("ops", deployDebug));

    await updateGate(tenant.id, "ops", { name: "ops-renamed" });

    const raw = await gateStore.getGateByName("ops-renamed");
    expect(raw).not.toBeNull();
    expect(raw!.classes.every((c) => c.gateName === "ops-renamed")).toBe(true);

    const hits = await searchByGate(
      "ops-renamed",
      tenant.id,
      gatewayEmbedding("deploy the application to production"),
      5,
    );
    expect(hits[0].label).toBe("deploy");
  });

  it("re-indexes embeddings when a class's utterances change", async () => {
    await createGate(
      tenant.id,
      gateInput("ops", [
        { label: "deploy", utterances: ["old deploy utterance"] },
        { label: "debug", utterances: ["debug a failing test"] },
      ]),
    );

    await updateClass(tenant.id, "ops", "deploy", { utterances: ["brand new deploy utterance"] });

    const fresh = await searchByGate(
      "ops",
      tenant.id,
      gatewayEmbedding("brand new deploy utterance"),
      5,
    );
    expect(fresh[0].label).toBe("deploy");

    const stale = await searchByGate("ops", tenant.id, gatewayEmbedding("old deploy utterance"), 5);
    expect(stale.some((h) => h.content === "old deploy utterance")).toBe(false);
  });

  it("renames a class and propagates the new label to its embeddings", async () => {
    await createGate(tenant.id, gateInput("ops", deployDebug));

    await updateClass(tenant.id, "ops", "deploy", { label: "ship" });

    const raw = await gateStore.getGateByName("ops");
    expect(raw!.classes.some((c) => c.label === "ship")).toBe(true);
    expect(raw!.classes.some((c) => c.label === "deploy")).toBe(false);

    const hits = await searchByGate(
      "ops",
      tenant.id,
      gatewayEmbedding("deploy the application to production"),
      5,
    );
    expect(hits.some((h) => h.label === "ship")).toBe(true);
    expect(hits.some((h) => h.label === "deploy")).toBe(false);
  });

  it("persists and returns class descriptions", async () => {
    await createGate(tenant.id, {
      name: "ops",
      config: { learningEnabled: true },
      classes: [
        {
          label: "deploy",
          description: "ship changes to production",
          utterances: ["deploy it"],
          keywords: ["deploy"],
        },
        {
          label: "debug",
          description: "fix failing tests",
          utterances: ["debug it"],
          keywords: ["debug"],
        },
      ],
    });

    const created = await getGate(tenant.id, "ops");
    expect(created!.classes.find((c) => c.label === "deploy")!.description).toBe(
      "ship changes to production",
    );

    await updateClass(tenant.id, "ops", "deploy", { description: "release a new version" });

    const updated = await getGate(tenant.id, "ops");
    expect(updated!.classes.find((c) => c.label === "deploy")!.description).toBe(
      "release a new version",
    );
  });

  it("rejects renaming a class to an existing label", async () => {
    await createGate(tenant.id, gateInput("ops", deployDebug));

    await expect(updateClass(tenant.id, "ops", "deploy", { label: "debug" })).rejects.toThrow(
      /Duplicate class label/,
    );
  });

  it("rejects wiping a class's utterances", async () => {
    await createGate(tenant.id, gateInput("ops", deployDebug));

    await expect(updateClass(tenant.id, "ops", "deploy", { utterances: [] })).rejects.toThrow(
      /at least one utterance/,
    );
  });

  it("rejects updating a class that does not exist", async () => {
    await createGate(tenant.id, gateInput("ops", deployDebug));

    await expect(updateClass(tenant.id, "ops", "missing", { keywords: ["x"] })).rejects.toThrow(
      /Class "missing" not found/,
    );
  });

  it("adds a class and indexes its utterances", async () => {
    await createGate(tenant.id, gateInput("ops", deployDebug));

    const cls = await addClass(tenant.id, "ops", {
      label: "rollback",
      keywords: ["rollback"],
      utterances: ["rollback a release"],
    });
    expect(cls.label).toBe("rollback");

    const hits = await searchByGate("ops", tenant.id, gatewayEmbedding("rollback a release"), 5);
    expect(hits[0].label).toBe("rollback");
  });

  it("rejects adding a duplicate class label", async () => {
    await createGate(tenant.id, gateInput("ops", deployDebug));

    await expect(
      addClass(tenant.id, "ops", { label: "deploy", utterances: ["x"] }),
    ).rejects.toThrow(/Duplicate class label/);
  });

  it("refuses to delete below the minimum class count and deletes otherwise", async () => {
    await createGate(tenant.id, gateInput("ops", deployDebug));

    await expect(deleteClass(tenant.id, "ops", "deploy")).rejects.toThrow(/at least 2 classes/);

    await addClass(tenant.id, "ops", { label: "rollback", utterances: ["rollback a release"] });
    await deleteClass(tenant.id, "ops", "deploy");

    const raw = await gateStore.getGateByName("ops");
    expect(raw!.classes.map((c) => c.label)).not.toContain("deploy");
  });

  it("rejects deleting a class that does not exist", async () => {
    await createGate(tenant.id, gateInput("ops", deployDebug));
    await addClass(tenant.id, "ops", { label: "rollback", utterances: ["rollback a release"] });

    await expect(deleteClass(tenant.id, "ops", "missing")).rejects.toThrow(
      /Class "missing" not found/,
    );
  });

  it("disables a gate so it is no longer visible", async () => {
    await createGate(tenant.id, gateInput("ops", deployDebug));

    await disableGate(tenant.id, "ops");

    expect(await getGate(tenant.id, "ops")).toBeNull();
    expect(await gateStore.getGateByName("ops")).toBeNull();
  });

  it("rejects disabling a gate that does not exist", async () => {
    await expect(disableGate(tenant.id, "nope")).rejects.toThrow(/Gate "nope" not found/);
  });

  it("lists a tenant's own gates together with the system gates", async () => {
    await createGate(tenant.id, gateInput("own", deployDebug));
    await gateStore.createGate(null, gateInput("sys", deployDebug));

    const gates = await listGates(tenant.id);
    expect(gates.map((g) => g.name).sort()).toEqual(["own", "sys"]);
  });
});
