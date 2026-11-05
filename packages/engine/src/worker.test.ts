import { describe, expect, it } from "vitest";
import { CRASH_POINTS, scriptedCrash } from "./crash.js";
import { createMemoryStores } from "./stores/memory.js";
import { EXPECTED_DROP_OFFSETS, EXPECTED_TOTALS, FIXTURE_EVENTS } from "./test/fixture.js";
import { drain, fixtureStores, kinds, ofKind, totals } from "./test/harness.js";
import { Worker } from "./worker.js";

describe("clean run", () => {
  const stores = fixtureStores();
  const { trace, crashes } = drain(stores);

  it("bills the expected ledger with no crashes", () => {
    expect(crashes).toHaveLength(0);
    expect(totals(stores.ledger)).toEqual(EXPECTED_TOTALS);
    expect(stores.drops.all().map((d) => d.offset)).toEqual(EXPECTED_DROP_OFFSETS);
  });

  it("runs the 7 steps per batch in protocol order", () => {
    const batch = ["planned", "read", "filtered", "dedupWritten", "aggregated", "sinkWritten", "committed"];
    expect(kinds(trace)).toEqual(["recovered", ...batch, ...batch, ...batch, "idle"]);
  });

  it("plans fixed ranges of maxBatch with increasing idx in one epoch", () => {
    expect(ofKind(trace, "planned").map((p) => p.plan)).toEqual([
      { id: { epoch: 1, idx: 1 }, startOffset: 0, endOffset: 3 },
      { id: { epoch: 1, idx: 2 }, startOffset: 4, endOffset: 7 },
      { id: { epoch: 1, idx: 3 }, startOffset: 8, endOffset: 11 },
    ]);
  });

  it("filters duplicates within a batch, across batches, and past-retention events", () => {
    expect(ofKind(trace, "filtered").map((f) => [f.kept, f.duplicates, f.dropped])).toEqual([
      [3, 1, 0], // m1 again in the same batch
      [2, 1, 1], // m2 from batch 1; m6 past retention
      [2, 2, 0], // m4 and m5 from batch 2
    ]);
  });
});

describe("replaying one batch five times in a row", () => {
  const stores = fixtureStores();
  const { trace, crashes } = drain(stores, {
    crash: scriptedCrash({ partition: 0, batchIdx: 2, point: "C3a", times: 5 }),
  });

  it("crashes five times, every replay keeping the original BatchId", () => {
    expect(crashes).toHaveLength(5);
    expect(crashes.map((c) => c.ctx.batchId)).toEqual(Array(5).fill({ epoch: 1, idx: 2 }));
    expect(crashes.map((c) => c.ctx.isReplay)).toEqual([false, true, true, true, true]);
    const replays = ofKind(trace, "recovered").filter((r) => r.replay);
    expect(replays.map((r) => r.replay!.id)).toEqual(Array(5).fill({ epoch: 1, idx: 2 }));
  });

  it("then plans batch 3 in epoch 6 and bills exactly once", () => {
    expect(ofKind(trace, "committed").at(-1)!.commit.id).toEqual({ epoch: 6, idx: 3 });
    expect(totals(stores.ledger)).toEqual(EXPECTED_TOTALS);
    expect(stores.drops.all()).toHaveLength(1);
  });
});

describe("dedup and sink order is interchangeable", () => {
  it("runs sink before dedup when asked", () => {
    const { trace } = drain(fixtureStores(), { stepOrder: "sinkThenDedup" });
    expect(kinds(trace).slice(1, 8)).toEqual([
      "planned",
      "read",
      "filtered",
      "aggregated",
      "sinkWritten",
      "dedupWritten",
      "committed",
    ]);
  });

  it.each(CRASH_POINTS)("sinkThenDedup with a crash at %s in batch 2 bills the expected ledger", (point) => {
    const stores = fixtureStores();
    const { crashes } = drain(stores, {
      stepOrder: "sinkThenDedup",
      crash: scriptedCrash({ partition: 0, batchIdx: 2, point }),
    });
    expect(crashes).toHaveLength(1);
    expect(totals(stores.ledger)).toEqual(EXPECTED_TOTALS);
    expect(stores.drops.all().map((d) => d.offset)).toEqual(EXPECTED_DROP_OFFSETS);
  });

  it.each(CRASH_POINTS)("crashing at %s in every batch still bills exactly once", (point) => {
    const stores = fixtureStores();
    const crash = scriptedCrash(
      { partition: 0, batchIdx: 1, point },
      { partition: 0, batchIdx: 2, point },
      { partition: 0, batchIdx: 3, point },
    );
    const { crashes } = drain(stores, { crash });
    expect(crashes).toHaveLength(3);
    expect(totals(stores.ledger)).toEqual(EXPECTED_TOTALS);
  });
});

describe("idle and growth", () => {
  it("writes no plan when there is nothing to read", () => {
    const stores = createMemoryStores(1);
    const w = new Worker({ partition: 0, stores, maxBatch: 4 });
    expect(w.step().kind).toBe("recovered");
    expect(w.step().kind).toBe("idle");
    expect(w.step().kind).toBe("idle");
    expect(stores.batchLogs[0]!.lastPlan()).toBeNull();
  });

  it("picks up records appended after going idle, and plans a short final batch", () => {
    const stores = createMemoryStores(1);
    const w = new Worker({ partition: 0, stores, maxBatch: 4 });
    w.step();
    expect(w.step().kind).toBe("idle");
    for (const e of FIXTURE_EVENTS.slice(0, 6)) stores.source.append(e);
    const plans = [];
    for (let r = w.step(); r.kind !== "idle"; r = w.step()) if (r.kind === "planned") plans.push(r.plan);
    expect(plans.map((p) => [p.startOffset, p.endOffset])).toEqual([
      [0, 3],
      [4, 5],
    ]);
  });
});

describe("guards", () => {
  it("throws if a dedup entry is newer than the current batch (I3 violated)", () => {
    const stores = fixtureStores();
    stores.dedup[0]!.putIfAbsent("m1", { id: { epoch: 9, idx: 9 }, seenAt: 0 });
    expect(() => drain(stores)).toThrow(/newer than/);
  });

  it("snapshot reports phase, batch and replay status", () => {
    const stores = fixtureStores();
    const w = new Worker({ partition: 0, stores, maxBatch: 4 });
    expect(w.snapshot().phase).toBe("recover");
    w.step();
    w.step();
    expect(w.snapshot()).toMatchObject({
      partition: 0,
      phase: "read",
      epoch: 1,
      isReplay: false,
      plan: { id: { epoch: 1, idx: 1 }, startOffset: 0, endOffset: 3 },
    });
  });
});
