import { describe, it, expect } from "vitest";
import { routeRequestSchema, feedbackSchema } from "./schema.js";

describe("routeRequestSchema", () => {
  it("accepts a valid request", () => {
    expect(() => routeRequestSchema.parse({ prompt: "deploy", gate: "ops" })).not.toThrow();
  });

  it("rejects an empty prompt", () => {
    expect(() => routeRequestSchema.parse({ prompt: "", gate: "ops" })).toThrow();
  });

  it("rejects a gate name over 100 chars", () => {
    expect(() => routeRequestSchema.parse({ prompt: "x", gate: "g".repeat(101) })).toThrow();
  });

  it("rejects a non-string prompt", () => {
    expect(() => routeRequestSchema.parse({ prompt: 123, gate: "ops" })).toThrow();
  });
});

describe("feedbackSchema", () => {
  it("accepts a valid positive feedback", () => {
    expect(() => feedbackSchema.parse({ routeId: "r_123", positive: true })).not.toThrow();
  });

  it("rejects a non-boolean positive", () => {
    expect(() => feedbackSchema.parse({ routeId: "r_123", positive: "yes" })).toThrow();
  });

  it("rejects an empty routeId", () => {
    expect(() => feedbackSchema.parse({ routeId: "", positive: true })).toThrow();
  });
});
