import { getEmbedClient } from "../clients/embed-client.js";
import type { LlmClient } from "../clients/llm-client.js";
import { toGate } from "../gates/service.js";
import type { Gate } from "../gates/types.js";
import * as embeddingsStore from "../store/embeddings.js";
import * as gateStore from "../store/gates.js";
import * as routingStore from "../store/routing.js";
import type { JudgeCandidate } from "../store/routing.js";
import { buildSystemPrompt, parseLabel } from "./classifiers/llm.js";
import { tokenize } from "./classifiers/keyword.js";
import {
  CAS_ENTROPY_THRESHOLD,
  CAS_MARGIN_THRESHOLD,
  JUDGE_BUDGET_DEFAULT,
  JUDGE_EXPLORE_RATIO,
  JUDGE_PER_CLASS_CAP,
  JUDGE_PER_PAIR_CAP,
  JUDGE_WATERMARK_KEY,
} from "./constants.js";

/** Tunable sampling knobs; budget is deployment-specific, the rest are algorithm constants. */
export type JudgeSelection = {
  budget: number;
  perPairCap: number;
  perClassCap: number;
  exploreRatio: number;
  marginThreshold: number;
  entropyThreshold: number;
  random?: () => number;
};

/**
 * Pick the routing events to judge this run.
 *
 * Exploitation ranks by uncertainty (low margin, high entropy) per
 * (tenant, gate) pair, capped per class and per pair, then globally by budget.
 * Exploration draws a small stratified-random sample from confident events to
 * catch confident errors that uncertainty sampling can never see.
 */
export function selectForJudge(
  candidates: JudgeCandidate[],
  opts: JudgeSelection,
): JudgeCandidate[] {
  const exploitBudget = Math.floor(opts.budget * (1 - opts.exploreRatio));
  const exploreBudget = Math.max(1, opts.budget - exploitBudget);
  const rand = opts.random ?? Math.random;

  const exploitPool: JudgeCandidate[] = [];
  const byPair = groupBy(candidates, (c) => `${c.tenantId}:${c.gateId}`);
  for (const pair of byPair.values()) {
    const ranked = [...pair].sort(byUncertainty);
    const byClass = groupBy(ranked, (c) => c.predictedClassId);
    const pairTop: JudgeCandidate[] = [];
    for (const classCandidates of byClass.values()) {
      pairTop.push(...classCandidates.slice(0, opts.perClassCap));
    }
    pairTop.sort(byUncertainty);
    exploitPool.push(...pairTop.slice(0, opts.perPairCap));
  }
  exploitPool.sort(byUncertainty);
  const exploit = exploitPool.slice(0, exploitBudget);
  const exploitIds = new Set(exploit.map((c) => c.id));

  const confident = candidates.filter(
    (c) =>
      !exploitIds.has(c.id) &&
      c.margin !== null &&
      c.entropy !== null &&
      c.margin >= opts.marginThreshold &&
      c.entropy <= opts.entropyThreshold,
  );
  const explore: JudgeCandidate[] = [];
  const byClassConfident = groupBy(confident, (c) => c.predictedClassId);
  const classIds = [...byClassConfident.keys()];
  const pools = new Map(classIds.map((id) => [id, [...byClassConfident.get(id)!]]));
  while (explore.length < exploreBudget) {
    let progressed = false;
    for (const classId of classIds) {
      if (explore.length >= exploreBudget) break;
      const pool = pools.get(classId)!;
      if (pool.length === 0) continue;
      const idx = Math.floor(rand() * pool.length);
      explore.push(pool.splice(idx, 1)[0]);
      progressed = true;
    }
    if (!progressed) break;
  }

  return [...exploit, ...explore];
}

/** Judge unlabeled routing events and write gold labels back as learning evidence. */
export async function learnInternally(
  judgeClient: LlmClient,
  opts: { budget?: number; model: string; random?: () => number },
): Promise<{ judged: number; failed: number }> {
  const budget = opts.budget ?? JUDGE_BUDGET_DEFAULT;
  const sinceId = await routingStore.getLearningWatermark(JUDGE_WATERMARK_KEY);
  const candidates = await routingStore.getUnjudgedCandidates(sinceId);

  const selected = selectForJudge(candidates, {
    budget,
    perPairCap: JUDGE_PER_PAIR_CAP,
    perClassCap: JUDGE_PER_CLASS_CAP,
    exploreRatio: JUDGE_EXPLORE_RATIO,
    marginThreshold: CAS_MARGIN_THRESHOLD,
    entropyThreshold: CAS_ENTROPY_THRESHOLD,
    random: opts.random,
  });

  const maxScannedId = candidates.reduce((max, c) => Math.max(max, c.id), sinceId);

  let judged = 0;
  let failed = 0;

  const byGate = groupBy(selected, (c) => c.gateId);
  for (const [gateId, group] of byGate) {
    const rawGate = await gateStore.getGateById(gateId);
    if (!rawGate) {
      for (const c of group) {
        await routingStore.insertJudgeLabel(c.id, null, opts.model, "failed");
      }
      failed += group.length;
      continue;
    }
    const gate = toGate(rawGate);
    const classIds = new Map(gate.classes.map((c) => [c.label, c.id]));
    for (const candidate of group) {
      try {
        const verdict = await judgeOne(judgeClient, gate, candidate.prompt);
        await writeJudgeOutcome(candidate, classIds.get(verdict.label) ?? null, opts.model);
        judged++;
      } catch {
        await routingStore.insertJudgeLabel(candidate.id, null, opts.model, "failed");
        failed++;
      }
    }
  }

  await routingStore.setLearningWatermark(JUDGE_WATERMARK_KEY, maxScannedId);
  return { judged, failed };
}

/** Run the judge once; throws when the answer is unusable so the caller marks it failed. */
async function judgeOne(
  judgeClient: LlmClient,
  gate: Gate,
  prompt: string,
): Promise<{ label: string }> {
  const labels = gate.classes.map((c) => c.label);
  const answer = await judgeClient.complete([
    { role: "system", content: buildSystemPrompt(gate) },
    { role: "user", content: prompt },
  ]);
  const label = parseLabel(answer, labels);
  if (label === null) throw new Error(`Judge returned no usable label: ${answer.slice(0, 120)}`);
  return { label };
}

/** Persist the judge label and fold it into the learning pipeline. */
async function writeJudgeOutcome(
  candidate: JudgeCandidate,
  goldClassId: number | null,
  model: string,
): Promise<void> {
  await routingStore.insertJudgeLabel(candidate.id, goldClassId, model, "ok");

  if (goldClassId === null) return;

  const keywords = [...tokenize(candidate.prompt)].filter((t) => t.length > 2);
  await routingStore.insertFeedback(
    candidate.routeId,
    1,
    keywords.length > 0 ? keywords : undefined,
    "judge",
    goldClassId,
  );

  const goldClass = await gateStore.getClassById(goldClassId);
  if (!goldClass) return;

  try {
    const embedding = await getEmbedClient().embed(candidate.prompt);

    if (goldClassId !== candidate.predictedClassId) {
      const predictedClass = await gateStore.getClassById(candidate.predictedClassId);
      if (predictedClass) {
        await embeddingsStore.deleteBySource(
          candidate.tenantId,
          predictedClass.id,
          candidate.prompt,
          "pos_feedback",
        );
        await embeddingsStore.insertMany([
          {
            tenantId: candidate.tenantId,
            classId: predictedClass.id,
            gateName: predictedClass.gateName,
            label: predictedClass.label,
            content: candidate.prompt,
            source: "neg_feedback",
            embedding,
          },
        ]);
      }
    }

    await embeddingsStore.deleteBySource(
      candidate.tenantId,
      goldClass.id,
      candidate.prompt,
      "neg_feedback",
    );
    await embeddingsStore.insertMany([
      {
        tenantId: candidate.tenantId,
        classId: goldClass.id,
        gateName: goldClass.gateName,
        label: goldClass.label,
        content: candidate.prompt,
        source: "pos_feedback",
        embedding,
      },
    ]);
  } catch (err) {
    console.warn("Judge embedding learning failed:", err);
  }
}

/** Rank by uncertainty: low margin first (NULL first), then high entropy (NULL last). */
function byUncertainty(a: JudgeCandidate, b: JudgeCandidate): number {
  if (a.margin === null && b.margin !== null) return -1;
  if (a.margin !== null && b.margin === null) return 1;
  if (a.margin !== null && b.margin !== null && a.margin !== b.margin) return a.margin - b.margin;
  if (a.entropy === null && b.entropy !== null) return 1;
  if (a.entropy !== null && b.entropy === null) return -1;
  if (a.entropy !== null && b.entropy !== null) return b.entropy - a.entropy;
  return 0;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}
