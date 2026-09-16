import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootTestApp, stopTestApp, type RunningApp } from "../helpers/e2e.js";
import { createTenant } from "../../src/store/tenants.js";
import { resetE2eData } from "../helpers/context.js";

let running: RunningApp;

beforeAll(async () => {
  running = await bootTestApp();
  await createTenant("tenant-e2e");
});
afterAll(async () => {
  await stopTestApp(running);
});
beforeEach(async () => {
  await resetE2eData();
});

function headers(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "intent-router-token": running.token,
    "intent-router-tenant": "tenant-e2e",
    ...overrides,
  };
}

const chatBody = (overrides: Record<string, unknown> = {}) => ({
  model: "ops",
  messages: [{ role: "user", content: "deploy the application to production" }],
  ...overrides,
});

describe("OpenAI-compatible lane", () => {
  it("lists the configured models", async () => {
    const res = await fetch(`${running.baseUrl}/v1/models`, { headers: headers() });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data.map((m: { id: string }) => m.id)).toContain("ops");
  });

  it("rejects a wrong service token", async () => {
    const res = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers({ "intent-router-token": "wrong-token" }),
      body: JSON.stringify(chatBody()),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a missing tenant header", async () => {
    const h = headers();
    delete h["intent-router-tenant"];
    const res = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(chatBody()),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown tenant", async () => {
    const res = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers({ "intent-router-tenant": "no-such-tenant" }),
      body: JSON.stringify(chatBody()),
    });
    expect(res.status).toBe(401);
  });

  it("completes a chat completion end to end", async () => {
    const res = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(chatBody()),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("ops");

    const payload = JSON.parse(body.choices[0].message.content);
    expect(payload.routeId).toMatch(/^r_/);
    expect(payload.label).toBe("deploy");
    expect(payload.stage).toBe("pre-cascade");
  });

  it("rejects an empty message list with 400", async () => {
    const res = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "ops", messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a request with no user message with 400", async () => {
    const res = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "ops", messages: [{ role: "system", content: "" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects streaming with 400", async () => {
    const res = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(chatBody({ stream: true })),
    });
    expect(res.status).toBe(400);
  });

  it("lists the classes of a gate", async () => {
    const res = await fetch(`${running.baseUrl}/v1/intent-router/gates/ops/classes`, {
      headers: { "intent-router-token": running.token },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.classes).toEqual(["deploy", "debug"]);
  });

  it("rejects the classes route without a service token", async () => {
    const res = await fetch(`${running.baseUrl}/v1/intent-router/gates/ops/classes`);
    expect(res.status).toBe(401);
  });

  it("maps an unknown gate to 404", async () => {
    const res = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(chatBody({ model: "no-such-gate" })),
    });
    expect(res.status).toBe(404);
  });
});
