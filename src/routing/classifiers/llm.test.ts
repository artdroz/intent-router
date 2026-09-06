import { describe, it, expect } from "vitest";
import {
  LlmClassifier,
  buildSystemPrompt,
  buildSchema,
  parseJsonResponse,
  parseResponse,
} from "./llm.js";
import type { LlmClient } from "../../lib/llm-client.js";
import type { Gate, GateClass } from "../../gates/types.js";

function makeClass(label: string, description?: string): GateClass {
  return {
    id: 0,
    label,
    description,
    utterances: ["placeholder"],
    keywords: [],
  };
}

function makeGate(classes: GateClass[]): Gate {
  return {
    id: 1,
    tenantId: "tenant-1",
    name: "test",
    description: "A test gate",
    config: { learningEnabled: true },
    classes,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("parseResponse", () => {
  it("grabs the first label via regex from plain text", () => {
    const { scores } = parseResponse("This needs a full debug pass", ["deploy", "debug"]);

    expect(scores.get("debug")).toBe(1);
    expect(scores.get("deploy")).toBe(0);
  });

  it("is case-insensitive", () => {
    const { scores } = parseResponse("Tier: REASONING", [
      "simple",
      "medium",
      "complex",
      "reasoning",
    ]);

    expect(scores.get("reasoning")).toBe(1);
    expect(scores.get("simple")).toBe(0);
  });

  it("matches a label inside JSON-like text without parsing it", () => {
    const { scores } = parseResponse('{"label":"debug"}', ["deploy", "debug"]);

    expect(scores.get("debug")).toBe(1);
    expect(scores.get("deploy")).toBe(0);
  });

  it("returns all-zero scores when no label is found", () => {
    const { scores } = parseResponse("unrelated gibberish", ["deploy", "debug"]);

    expect(scores.get("deploy")).toBe(0);
    expect(scores.get("debug")).toBe(0);
  });

  it("handles labels containing regex metacharacters", () => {
    // Without escaping, the `(` would make the RegExp constructor throw.
    const { scores } = parseResponse("use a(b here", ["a(b", "python"]);

    expect(scores.get("a(b")).toBe(1);
    expect(scores.get("python")).toBe(0);
  });
});

describe("parseJsonResponse", () => {
  it("parses a structured distribution and clamps negative scores to 0", () => {
    const raw = '{"reasoning":"r","distribution":{"deploy":2,"debug":-1}}';
    const { scores, evidence } = parseJsonResponse(raw, ["deploy", "debug"]);

    expect(scores.get("deploy")).toBe(2);
    expect(scores.get("debug")).toBe(0);
    expect(evidence.get("deploy")).toEqual(["r"]);
    expect(evidence.get("debug")).toEqual(["r"]);
  });

  it("treats missing or non-numeric distribution entries as 0", () => {
    const raw = '{"distribution":{"deploy":1,"debug":"high"}}';
    const { scores } = parseJsonResponse(raw, ["deploy", "debug", "other"]);

    expect(scores.get("deploy")).toBe(1);
    expect(scores.get("debug")).toBe(0);
    expect(scores.get("other")).toBe(0);
  });

  it("strips markdown code fences before parsing", () => {
    const raw = '```json\n{"reasoning":"r","distribution":{"deploy":1,"debug":0}}\n```';
    const { scores } = parseJsonResponse(raw, ["deploy", "debug"]);

    expect(scores.get("deploy")).toBe(1);
    expect(scores.get("debug")).toBe(0);
  });

  it("falls back to regex when the JSON is unparseable", () => {
    const raw = "definitely not json, just deploy it";
    const { scores } = parseJsonResponse(raw, ["deploy", "debug"]);

    expect(scores.get("deploy")).toBe(1);
    expect(scores.get("debug")).toBe(0);
  });

  it("returns empty scores when no label can be recovered", () => {
    const { scores, evidence } = parseJsonResponse("gibberish", ["deploy", "debug"]);

    expect(scores.size).toBe(0);
    expect(evidence.size).toBe(0);
  });
});

describe("buildSystemPrompt", () => {
  it("asks for a bare label and does not request JSON", () => {
    const gate = makeGate([makeClass("deploy", "Ship code"), makeClass("debug", "Fix bugs")]);
    const prompt = buildSystemPrompt(gate);

    expect(prompt).toContain('"deploy"');
    expect(prompt).toContain("Fix bugs");
    expect(prompt).toContain("No JSON");
    expect(prompt).not.toContain("distribution");
    expect(prompt).not.toContain('{"label"');
  });
});

describe("buildSchema", () => {
  it("returns undefined (no structured output requested)", () => {
    expect(buildSchema(["deploy", "debug"])).toBeUndefined();
  });
});

describe("LlmClassifier.classify", () => {
  it("passes the system prompt and response format to the client", async () => {
    let captured: { role: string; content: string }[] | null = null;
    const client: LlmClient = {
      complete: (messages) => {
        captured = messages;
        return Promise.resolve('{"reasoning":"x","distribution":{"deploy":1,"debug":0}}');
      },
    };

    const gate = makeGate([makeClass("deploy", "Ship"), makeClass("debug", "Fix")]);
    await new LlmClassifier(client).classify("deploy", gate, "tenant-1");

    expect(captured![0].role).toBe("system");
    expect(captured![0].content).toContain("deploy");
    expect(captured![1]).toEqual({ role: "user", content: "deploy" });
  });

  it("maps the single chosen label to prob 1 and the rest to 0", async () => {
    const client: LlmClient = {
      complete: () => Promise.resolve('{"label":"debug"}'),
    };

    const gate = makeGate([makeClass("deploy"), makeClass("debug")]);
    const result = await new LlmClassifier(client).classify("deploy", gate, "tenant-1");

    expect(result.entries.get("deploy")!.prob).toBe(0);
    expect(result.entries.get("debug")!.prob).toBe(1);
  });
});
