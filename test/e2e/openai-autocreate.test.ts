import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestApp, stopTestApp, type RunningApp } from "../helpers/e2e.js";
import { findTenantByName } from "../../src/store/tenants.js";

let running: RunningApp;

beforeAll(async () => {
  process.env.AUTO_CREATE_TENANT = "true";
  running = await bootTestApp();
});
afterAll(async () => {
  await stopTestApp(running);
});

function headers(tenant: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "intent-router-token": running.token,
    "intent-router-tenant": tenant,
  };
}

const chatBody = () => ({
  model: "ops",
  messages: [{ role: "user", content: "deploy the application to production" }],
});

describe("OpenAI-compatible lane with AUTO_CREATE_TENANT", () => {
  it("creates an unknown tenant and routes the request", async () => {
    const res = await fetch(`${running.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers("auto-created-tenant"),
      body: JSON.stringify(chatBody()),
    });
    expect(res.status).toBe(200);

    const tenant = await findTenantByName("auto-created-tenant");
    expect(tenant).not.toBeNull();
  });
});
