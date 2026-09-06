import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootTestApp, stopTestApp, type RunningApp } from "../helpers/e2e.js";
import { createApiKey } from "../../src/auth/api-keys.js";
import { createTenant } from "../../src/store/tenants.js";
import type { TenantRow } from "../../src/store/schema.js";
import { resetE2eData } from "../helpers/context.js";

let running: RunningApp;
let tenant: TenantRow;
let apiKey: string;

beforeAll(async () => {
  running = await bootTestApp();
  tenant = await createTenant("tenant-e2e");
});
afterAll(async () => {
  await stopTestApp(running);
});
beforeEach(async () => {
  await resetE2eData();
  apiKey = await createApiKey({ tenantId: tenant.id, name: "e2e-key" });
});

function auth() {
  return { Authorization: `Bearer ${apiKey}` };
}

function json() {
  return { "Content-Type": "application/json" };
}

describe("REST lane (API-key auth)", () => {
  it("rejects requests without an API key", async () => {
    const res = await fetch(`${running.baseUrl}/api/gates`);
    expect(res.status).toBe(401);
  });

  it("rejects an invalid API key", async () => {
    const res = await fetch(`${running.baseUrl}/api/gates`, {
      headers: { Authorization: "Bearer sk-bad" },
    });
    expect(res.status).toBe(401);
  });

  it("creates a gate and lists it alongside the system gate", async () => {
    const created = await fetch(`${running.baseUrl}/api/gates`, {
      method: "POST",
      headers: { ...auth(), ...json() },
      body: JSON.stringify({
        name: "tenant-gate",
        config: { learningEnabled: true },
        classes: [
          { label: "alpha", utterances: ["alpha utterance"], keywords: ["alpha"] },
          { label: "beta", utterances: ["beta utterance"], keywords: ["beta"] },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const gate = await created.json();
    expect(gate.name).toBe("tenant-gate");

    const list = await fetch(`${running.baseUrl}/api/gates`, { headers: auth() });
    expect(list.status).toBe(200);
    const gates = await list.json();
    const names = gates.map((g: { name: string }) => g.name);
    expect(names).toContain("tenant-gate");
    expect(names).toContain("ops");
  });

  it("gets a gate by name and 404s for an unknown gate", async () => {
    const ok = await fetch(`${running.baseUrl}/api/gates/ops`, { headers: auth() });
    expect(ok.status).toBe(200);

    const missing = await fetch(`${running.baseUrl}/api/gates/nope`, { headers: auth() });
    expect(missing.status).toBe(404);
  });

  it("supports the full gate CRUD lifecycle", async () => {
    await fetch(`${running.baseUrl}/api/gates`, {
      method: "POST",
      headers: { ...auth(), ...json() },
      body: JSON.stringify({
        name: "tenant-gate",
        config: { learningEnabled: true },
        classes: [
          { label: "alpha", utterances: ["alpha utterance"], keywords: ["alpha"] },
          { label: "beta", utterances: ["beta utterance"], keywords: ["beta"] },
        ],
      }),
    });

    const added = await fetch(`${running.baseUrl}/api/gates/tenant-gate/classes`, {
      method: "POST",
      headers: { ...auth(), ...json() },
      body: JSON.stringify({ label: "gamma", utterances: ["gamma utterance"] }),
    });
    expect(added.status).toBe(201);

    const patched = await fetch(`${running.baseUrl}/api/gates/tenant-gate/classes/alpha`, {
      method: "PATCH",
      headers: { ...auth(), ...json() },
      body: JSON.stringify({ keywords: ["new-alpha"] }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.keywords).toEqual(["new-alpha"]);

    const deleted = await fetch(`${running.baseUrl}/api/gates/tenant-gate/classes/alpha`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(deleted.status).toBe(204);

    const disabled = await fetch(`${running.baseUrl}/api/gates/tenant-gate`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(disabled.status).toBe(204);

    const gone = await fetch(`${running.baseUrl}/api/gates/tenant-gate`, { headers: auth() });
    expect(gone.status).toBe(404);
  });

  it("routes a prompt and submits feedback", async () => {
    const routed = await fetch(`${running.baseUrl}/api/route`, {
      method: "POST",
      headers: { ...auth(), ...json() },
      body: JSON.stringify({ prompt: "deploy the application to production", gate: "ops" }),
    });
    expect(routed.status).toBe(200);
    const routeBody = await routed.json();
    expect(routeBody.routeId).toMatch(/^r_/);
    expect(routeBody.label).toBe("deploy");
    expect(routeBody.stage).toBe("pre-cascade");

    const fedBack = await fetch(`${running.baseUrl}/api/feedback`, {
      method: "POST",
      headers: { ...auth(), ...json() },
      body: JSON.stringify({ routeId: routeBody.routeId, positive: true }),
    });
    expect(fedBack.status).toBe(204);
  });

  it("rejects an invalid route body with 400", async () => {
    const res = await fetch(`${running.baseUrl}/api/route`, {
      method: "POST",
      headers: { ...auth(), ...json() },
      body: JSON.stringify({ prompt: "", gate: "ops" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when routing against an unknown gate", async () => {
    const res = await fetch(`${running.baseUrl}/api/route`, {
      method: "POST",
      headers: { ...auth(), ...json() },
      body: JSON.stringify({ prompt: "hello", gate: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});
