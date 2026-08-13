import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertValidClasses, createGate, deleteClass, updateClass } from "./service.js";
import * as store from "../store/gates.js";
import type { CreateGateInput } from "./schema.js";
import type { GateRow, ClassRow } from "../store/schema.js";

vi.mock("../store/gates.js");

const getGateByName = vi.mocked(store.getGateByName);
const storeDeleteClass = vi.mocked(store.deleteClass);
const storeUpdateClass = vi.mocked(store.updateClass);
const storeCreateGate = vi.mocked(store.createGate);
const gateNameExists = vi.mocked(store.gateNameExists);

function existingWithClasses(count: number) {
  return {
    gate: {} as GateRow,
    classes: Array.from({ length: count }, () => ({})) as ClassRow[],
  };
}

function classRow(label: string, utterances: string[] = ["x"]): ClassRow {
  return { label, utterances } as ClassRow;
}

describe("assertValidClasses", () => {
  it("accepts a valid class list", () => {
    expect(() =>
      assertValidClasses([
        { label: "a", utterances: ["x"] },
        { label: "b", utterances: ["y"] },
      ]),
    ).not.toThrow();
  });

  it("rejects fewer than two classes", () => {
    expect(() => assertValidClasses([{ label: "a", utterances: ["x"] }])).toThrow(
      /at least 2 classes/,
    );
  });

  it("rejects more than 50 classes", () => {
    const classes = Array.from({ length: 51 }, (_, i) => ({
      label: `c${i}`,
      utterances: ["x"],
    }));
    expect(() => assertValidClasses(classes)).toThrow(/more than 50/);
  });

  it("rejects duplicate labels", () => {
    expect(() =>
      assertValidClasses([
        { label: "a", utterances: ["x"] },
        { label: "a", utterances: ["y"] },
      ]),
    ).toThrow(/Duplicate class label "a"/);
  });

  it("rejects a class with no utterances", () => {
    expect(() =>
      assertValidClasses([
        { label: "a", utterances: ["x"] },
        { label: "b", utterances: [] },
      ]),
    ).toThrow(/must have at least one utterance/);
  });

  it("rejects a class with undefined utterances", () => {
    expect(() => assertValidClasses([{ label: "a", utterances: ["x"] }, { label: "b" }])).toThrow(
      /must have at least one utterance/,
    );
  });

  it("rejects a class with null utterances", () => {
    expect(() =>
      assertValidClasses([
        { label: "a", utterances: ["x"] },
        { label: "b", utterances: null },
      ]),
    ).toThrow(/must have at least one utterance/);
  });
});

describe("deleteClass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects deletion when fewer than two classes", async () => {
    getGateByName.mockResolvedValue(existingWithClasses(2));

    await expect(deleteClass(1, "ops", "c0")).rejects.toThrow(/must have at least 2 classes/);
    expect(storeDeleteClass).not.toHaveBeenCalled();
  });

  it("accepts a valid deletion", async () => {
    getGateByName.mockResolvedValue(existingWithClasses(3));
    storeDeleteClass.mockResolvedValue(true);

    await expect(deleteClass(1, "ops", "c0")).resolves.toBeUndefined();
    expect(storeDeleteClass).toHaveBeenCalledWith(1, "ops", "c0");
  });
});

describe("updateClass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a label rename that collides with an existing class", async () => {
    getGateByName.mockResolvedValue({
      gate: {} as GateRow,
      classes: [classRow("deploy", ["ship it"]), classRow("debug", ["fix it"])],
    });

    await expect(updateClass(1, "ops", "deploy", { label: "debug" })).rejects.toThrow(
      /Duplicate class label "debug"/,
    );
    expect(storeUpdateClass).not.toHaveBeenCalled();
  });

  it("rejects wiping a class's utterances", async () => {
    getGateByName.mockResolvedValue({
      gate: {} as GateRow,
      classes: [classRow("deploy", ["ship it"]), classRow("debug", ["fix it"])],
    });

    await expect(updateClass(1, "ops", "deploy", { utterances: [] })).rejects.toThrow(
      /must have at least one utterance/,
    );
    expect(storeUpdateClass).not.toHaveBeenCalled();
  });
});

describe("createGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects creating a gate with an existing name", async () => {
    gateNameExists.mockResolvedValue(true);

    const input: CreateGateInput = {
      name: "ops",
      config: { learningEnabled: true },
      classes: [
        { label: "deploy", utterances: ["ship it"] },
        { label: "debug", utterances: ["fix it"] },
      ],
    };

    await expect(createGate(1, input)).rejects.toThrow(/already exists/);
    expect(storeCreateGate).not.toHaveBeenCalled();
  });
});
