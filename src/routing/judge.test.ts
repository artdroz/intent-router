import { describe, expect, it } from "vitest";
import { selectForJudge } from "./judge.js";
import type { JudgeCandidate } from "../store/routing.js";

function candidate(overrides: Partial<JudgeCandidate> = {}): JudgeCandidate {
  return {
    id: 1,
    routeId: "r_1",
    tenantId: "t1",
    gateId: 1,
    predictedClassId: 1,
    prompt: "deploy the app",
    margin: 0.5,
    entropy: 0.5,
    ...overrides,
  };
}

const baseOpts = {
  budget: 10,
  perPairCap: 10,
  perClassCap: 10,
  exploreRatio: 0.1,
  marginThreshold: 0.54,
  entropyThreshold: 0.78,
};

describe("selectForJudge", () => {
  it("ranks exploit candidates by uncertainty: NULL margin first, then margin asc, then entropy desc", () => {
    const candidates = [
      candidate({ id: 1, margin: null, entropy: 0.5 }),
      candidate({ id: 2, margin: 0.5, entropy: 0.5 }),
      candidate({ id: 3, margin: 0.2, entropy: 0.5 }),
      candidate({ id: 4, margin: 0.2, entropy: 0.9 }),
    ];

    const selected = selectForJudge(candidates, { ...baseOpts, budget: 10, exploreRatio: 0 });

    expect(selected.map((c) => c.id)).toEqual([1, 4, 3, 2]);
  });

  it("caps each class and the pair, and skips exploration when nothing is confident", () => {
    const class1 = [0.2, 0.3, 0.4, 0.5].map((margin, i) =>
      candidate({ id: 10 + i, margin, entropy: 0.9, predictedClassId: 1 }),
    );
    const class2 = [0.1, 0.15, 0.25, 0.6].map((margin, i) =>
      candidate({ id: 20 + i, margin, entropy: 0.9, predictedClassId: 2 }),
    );

    const selected = selectForJudge([...class1, ...class2], {
      ...baseOpts,
      budget: 100,
      perClassCap: 2,
      perPairCap: 3,
      exploreRatio: 0,
    });

    expect(selected.map((c) => c.id)).toEqual([20, 21, 10]);
  });

  it("fills the explore slice from confident events not already exploited", () => {
    const events = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9].map((margin, i) =>
      candidate({ id: i + 1, margin, entropy: 0.5 }),
    );

    const selected = selectForJudge(events, {
      ...baseOpts,
      budget: 4,
      exploreRatio: 0.25,
      random: () => 0,
    });

    expect(selected.map((c) => c.id)).toEqual([1, 2, 3, 4]);
  });
});
