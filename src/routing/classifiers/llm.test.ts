import { describe, it, expect } from "vitest";
import { LlmClassifier, buildSystemPrompt, buildSchema, parseResponse } from "./llm.js";
import type { LlmClient } from "../../lib/llm-client.js";
import type { Gate, GateClass } from "../../gates/types.js";

function makeClass(label: string, description?: string): GateClass {
  return {
    label,
    description,
    utterances: ["placeholder"],
    keywords: [],
    promotedKeywords: [],
  };
}

function makeGate(classes: GateClass[]): Gate {
  return {
    id: 1,
    name: "test",
    description: "A test gate",
    config: { learningEnabled: true },
    classes,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("buildSystemPrompt", () => {
  it("lists every class label with a description", () => {
    const gate = makeGate([makeClass("deploy", "Ship code"), makeClass("debug", "Fix bugs")]);
    const prompt = buildSystemPrompt(gate);

    expect(prompt).toContain('"deploy"');
    expect(prompt).toContain("Ship code");
    expect(prompt).toContain('"debug"');
    expect(prompt).toContain("Fix bugs");
  });

  it("uses 'No description' when a class has no description", () => {
    const gate = makeGate([makeClass("deploy"), makeClass("debug")]);
    const prompt = buildSystemPrompt(gate);

    expect(prompt).toContain("No description");
  });
});

describe("buildSchema", () => {
  it("builds a schema requiring every label in the distribution", () => {
    const schema = buildSchema(["deploy", "debug"]);

    expect(schema.schema.properties.distribution.required).toEqual(["deploy", "debug"]);
    expect(schema.schema.properties.distribution.properties.deploy).toEqual({ type: "number" });
  });

  it("marks additionalProperties as false", () => {
    const schema = buildSchema(["deploy"]);

    expect(schema.schema.properties.distribution.additionalProperties).toBe(false);
  });
});

describe("parseResponse", () => {
  it("parses a clean JSON distribution into raw scores", () => {
    const { scores } = parseResponse(
      '{"reasoning":"x","distribution":{"deploy":0.7,"debug":0.3}}',
      ["deploy", "debug"],
    );

    expect(scores.get("deploy")).toBeCloseTo(0.7);
    expect(scores.get("debug")).toBeCloseTo(0.3);
  });

  it("strips markdown code fences", () => {
    const { scores } = parseResponse(
      '```json\n{"reasoning":"x","distribution":{"deploy":1,"debug":0}}\n```',
      ["deploy", "debug"],
    );

    expect(scores.get("deploy")).toBe(1);
  });

  it("returns empty scores on invalid JSON", () => {
    const { scores } = parseResponse("not json", ["deploy", "debug"]);

    expect(scores.size).toBe(0);
  });

  it("returns empty scores when distribution is missing", () => {
    const { scores } = parseResponse('{"reasoning":"x"}', ["deploy", "debug"]);

    expect(scores.size).toBe(0);
  });

  it("clamps negative probabilities to 0", () => {
    const { scores } = parseResponse(
      '{"reasoning":"x","distribution":{"deploy":-0.5,"debug":1.5}}',
      ["deploy", "debug"],
    );

    expect(scores.get("deploy")).toBe(0);
  });

  it("keeps raw non-normalized scores", () => {
    const { scores } = parseResponse('{"reasoning":"x","distribution":{"deploy":2,"debug":2}}', [
      "deploy",
      "debug",
    ]);

    expect(scores.get("deploy")).toBe(2);
  });

  it("defaults a missing label to zero", () => {
    const { scores } = parseResponse('{"reasoning":"x","distribution":{"deploy":1}}', [
      "deploy",
      "debug",
    ]);

    expect(scores.get("debug")).toBe(0);
  });

  it("attaches the reasoning sentence as evidence for every label", () => {
    const { evidence } = parseResponse(
      '{"reasoning":"ship it","distribution":{"deploy":1,"debug":0}}',
      ["deploy", "debug"],
    );

    expect(evidence.get("deploy")).toEqual(["ship it"]);
    expect(evidence.get("debug")).toEqual(["ship it"]);
  });
});

describe("LlmClassifier.classify", () => {
  it("passes the system prompt and response format to the client", async () => {
    let captured: { role: string; content: string }[] | null = null;
    const client: LlmClient = {
      complete: async (messages) => {
        captured = messages;
        return '{"reasoning":"x","distribution":{"deploy":1,"debug":0}}';
      },
    };

    const gate = makeGate([makeClass("deploy", "Ship"), makeClass("debug", "Fix")]);
    await new LlmClassifier(client).classify("deploy", gate);

    expect(captured![0].role).toBe("system");
    expect(captured![0].content).toContain("deploy");
    expect(captured![1]).toEqual({ role: "user", content: "deploy" });
  });

  it("normalizes the parsed distribution", async () => {
    const client: LlmClient = {
      complete: async () => '{"reasoning":"x","distribution":{"deploy":2,"debug":2}}',
    };

    const gate = makeGate([makeClass("deploy"), makeClass("debug")]);
    const result = await new LlmClassifier(client).classify("deploy", gate);

    expect(result.entries.get("deploy")!.prob).toBeCloseTo(0.5);
    expect(result.entries.get("debug")!.prob).toBeCloseTo(0.5);
  });
});
