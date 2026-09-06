import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestApp, stopTestApp, type RunningApp } from "../helpers/e2e.js";

let running: RunningApp;

beforeAll(async () => {
  running = await bootTestApp();
});
afterAll(async () => {
  await stopTestApp(running);
});

describe("health endpoints", () => {
  it("reports liveness", async () => {
    const res = await fetch(`${running.baseUrl}/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("reports readiness when the database is reachable", async () => {
    const res = await fetch(`${running.baseUrl}/ready`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
  });
});
