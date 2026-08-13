import { describe, it, expect } from "vitest";
import { createGateSchema, addClassSchema, updateGateSchema, updateClassSchema } from "./schema.js";

describe("createGateSchema", () => {
  const valid = {
    name: "ops",
    config: { learningEnabled: true },
    classes: [
      { label: "deploy", utterances: ["ship it"], keywords: ["deploy"] },
      { label: "debug", utterances: ["fix it"], keywords: ["debug"] },
    ],
  };

  it("accepts a valid gate", () => {
    expect(() => createGateSchema.parse(valid)).not.toThrow();
  });

  it("rejects a name shorter than 2 chars", () => {
    expect(() => createGateSchema.parse({ ...valid, name: "a" })).toThrow();
  });

  it("rejects an empty classes array", () => {
    expect(() => createGateSchema.parse({ ...valid, classes: [] })).toThrow();
  });

  it("rejects a missing config", () => {
    const { config: _config, ...rest } = valid;
    expect(() => createGateSchema.parse(rest)).toThrow();
  });

  it("rejects an empty class label", () => {
    expect(() =>
      createGateSchema.parse({
        ...valid,
        classes: [{ ...valid.classes[0], label: "" }, valid.classes[1]],
      }),
    ).toThrow();
  });
});

describe("addClassSchema", () => {
  it("accepts a class with utterances", () => {
    expect(() =>
      addClassSchema.parse({ label: "deploy", utterances: ["ship it"] }),
    ).not.toThrow();
  });

  it("rejects a label over 50 chars", () => {
    expect(() => addClassSchema.parse({ label: "x".repeat(51) })).toThrow();
  });
});

describe("updateGateSchema", () => {
  it("accepts a partial update with only name", () => {
    expect(() => updateGateSchema.parse({ name: "new-name" })).not.toThrow();
  });

  it("accepts an empty object (no-op update)", () => {
    expect(() => updateGateSchema.parse({})).not.toThrow();
  });
});

describe("updateClassSchema", () => {
  it("accepts a partial update", () => {
    expect(() => updateClassSchema.parse({ utterances: ["new"] })).not.toThrow();
  });

  it("rejects empty utterances array elements", () => {
    expect(() => updateClassSchema.parse({ utterances: [""] })).toThrow();
  });
});
