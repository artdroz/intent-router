import { beforeEach, describe, expect, it, vi } from "vitest";
import { submitFeedback } from "./service.js";
import * as routingStore from "../store/routing.js";
import * as gateStore from "../store/gates.js";
import * as embeddingsStore from "../store/embeddings.js";
import { getEmbedClient } from "../clients/embed-client.js";
import type { ClassRow, RoutingEventRow } from "../store/schema.js";

vi.mock("../store/routing.js");
vi.mock("../store/gates.js");
vi.mock("../store/embeddings.js");
vi.mock("../clients/embed-client.js");

const getRouteByRouteId = vi.mocked(routingStore.getRouteByRouteId);
const insertFeedback = vi.mocked(routingStore.insertFeedback);
const getClassById = vi.mocked(gateStore.getClassById);
const deleteBySource = vi.mocked(embeddingsStore.deleteBySource);
const insertMany = vi.mocked(embeddingsStore.insertMany);
const embedClient = vi.mocked(getEmbedClient);

function routeEvent(overrides: Partial<RoutingEventRow> = {}): RoutingEventRow {
  return {
    id: 1,
    routeId: "r_abc",
    tenantId: "tenant-1",
    gateId: 1,
    prompt: "deploy the app",
    predictedClassId: 42,
    stage: "pre-cascade",
    scores: {},
    margin: null,
    entropy: null,
    channel: "rest",
    createdAt: new Date(),
    ...overrides,
  };
}

const predictedClass = {
  id: 42,
  gateId: 1,
  gateName: "ops",
  label: "deploy",
  description: null,
  utterances: [],
  keywords: [],
  weight: 1,
} as ClassRow;

describe("submitFeedback (embedding learning)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embedClient.mockReturnValue({ embed: () => Promise.resolve([0.1, 0.2, 0.3]), dims: 3 });
  });

  it("positive feedback stores a pos_feedback embedding and clears the negative guardrail", async () => {
    getRouteByRouteId.mockResolvedValue(routeEvent());
    getClassById.mockResolvedValue(predictedClass);

    await submitFeedback({ routeId: "r_abc", positive: true }, "tenant-1");

    await vi.waitFor(() => {
      expect(deleteBySource).toHaveBeenCalledWith("tenant-1", 42, "deploy the app", "neg_feedback");
      expect(insertMany).toHaveBeenCalledWith([
        expect.objectContaining({
          tenantId: "tenant-1",
          classId: 42,
          gateName: "ops",
          label: "deploy",
          content: "deploy the app",
          source: "pos_feedback",
          embedding: [0.1, 0.2, 0.3],
        }),
      ]);
    });
  });

  it("negative feedback stores a neg_feedback guardrail and clears the positive embedding", async () => {
    getRouteByRouteId.mockResolvedValue(routeEvent({ scores: { deploy: 0.9, other: 0.1 } }));
    getClassById.mockResolvedValue(predictedClass);

    await submitFeedback({ routeId: "r_abc", positive: false }, "tenant-1");

    await vi.waitFor(() => {
      expect(deleteBySource).toHaveBeenCalledWith("tenant-1", 42, "deploy the app", "pos_feedback");
      expect(insertMany).toHaveBeenCalledWith([
        expect.objectContaining({
          source: "neg_feedback",
          classId: 42,
          label: "deploy",
          content: "deploy the app",
        }),
      ]);
    });
  });

  it("skips negative feedback learning when the error is not confident", async () => {
    getRouteByRouteId.mockResolvedValue(routeEvent()); // scores: {} → unknown margin
    getClassById.mockResolvedValue(predictedClass);

    await submitFeedback({ routeId: "r_abc", positive: false }, "tenant-1");

    expect(deleteBySource).not.toHaveBeenCalled();
    expect(insertMany).not.toHaveBeenCalled();
  });

  it("skips negative feedback learning when the top-2 margin is below LRN_NEG_MARGIN", async () => {
    getRouteByRouteId.mockResolvedValue(
      routeEvent({ scores: { deploy: 0.55, other: 0.45 } }), // margin 0.10 < 0.20
    );
    getClassById.mockResolvedValue(predictedClass);

    await submitFeedback({ routeId: "r_abc", positive: false }, "tenant-1");

    expect(insertMany).not.toHaveBeenCalled();
  });

  it("learns from negative feedback when the top-2 margin equals LRN_NEG_MARGIN", async () => {
    getRouteByRouteId.mockResolvedValue(
      routeEvent({ scores: { deploy: 0.6, other: 0.4 } }), // margin 0.20 → inclusive
    );
    getClassById.mockResolvedValue(predictedClass);

    await submitFeedback({ routeId: "r_abc", positive: false }, "tenant-1");

    await vi.waitFor(() => expect(insertMany).toHaveBeenCalled());
  });

  it("learns from any llm-stage miss even when the top-2 margin is small", async () => {
    getRouteByRouteId.mockResolvedValue(
      routeEvent({ stage: "llm", scores: { deploy: 0.55, other: 0.45 } }), // margin 0.10 < 0.20, but the llm stage committed to a bare label
    );
    getClassById.mockResolvedValue(predictedClass);

    await submitFeedback({ routeId: "r_abc", positive: false }, "tenant-1");

    await vi.waitFor(() => expect(insertMany).toHaveBeenCalled());
  });

  it("persists feedback even when embedding fails", async () => {
    getRouteByRouteId.mockResolvedValue(routeEvent());
    embedClient.mockReturnValue({
      embed: () => Promise.reject(new Error("embed down")),
      dims: 3,
    });

    await expect(
      submitFeedback({ routeId: "r_abc", positive: true }, "tenant-1"),
    ).resolves.toBeUndefined();

    expect(insertFeedback).toHaveBeenCalled();
    expect(insertMany).not.toHaveBeenCalled();
  });

  it("skips embedding learning when the predicted class no longer exists", async () => {
    getRouteByRouteId.mockResolvedValue(routeEvent());
    // getClassById's inferred return type is non-null (see store), but it can
    // still return null at runtime when the class was deleted.
    getClassById.mockResolvedValue(null as never);

    await submitFeedback({ routeId: "r_abc", positive: true }, "tenant-1");

    expect(insertMany).not.toHaveBeenCalled();
    expect(deleteBySource).not.toHaveBeenCalled();
  });

  it("rejects feedback from a tenant that did not create the route", async () => {
    getRouteByRouteId.mockResolvedValue(routeEvent({ tenantId: "tenant-other" }));

    await expect(submitFeedback({ routeId: "r_abc", positive: true }, "tenant-1")).rejects.toThrow(
      /not found/,
    );

    expect(insertMany).not.toHaveBeenCalled();
  });
});
