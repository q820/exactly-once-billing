import { describe, expect, it } from "vitest";
import { scriptedCrash, type CrashPoint } from "./crash.js";
import { EXPECTED_DROP_OFFSETS, EXPECTED_TOTALS } from "./test/fixture.js";
import { drain, fixtureStores, ofKind, totals } from "./test/harness.js";

/**
 * One test per named crash point, all crashing during batch 2 (offsets 4-7) of
 * the fixture, with every safeguard on. After restart and drain the ledger must
 * equal the hand-computed totals.
 */

const REPLAYING_POINTS: CrashPoint[] = ["C1", "C2a", "C2", "C3a", "C3"];

describe.each(REPLAYING_POINTS)("crash at %s during batch 2", (point) => {
  const stores = fixtureStores();
  const { trace, crashes } = drain(stores, {
    crash: scriptedCrash({ partition: 0, batchIdx: 2, point }),
  });

  it("crashes exactly once, at that point, during the first attempt", () => {
    expect(crashes).toHaveLength(1);
    expect(crashes[0]!.point).toBe(point);
    expect(crashes[0]!.ctx.batchId).toEqual({ epoch: 1, idx: 2 });
    expect(crashes[0]!.ctx.isReplay).toBe(false);
  });

  it("bumps the epoch on restart and replays batch 2 under its original id", () => {
    const recoveries = ofKind(trace, "recovered");
    expect(recoveries.map((r) => r.epoch)).toEqual([1, 2]);
    expect(recoveries[1]!.replay).toEqual({ id: { epoch: 1, idx: 2 }, startOffset: 4, endOffset: 7 });
  });

  it("plans the batch after the replay with the new epoch", () => {
    const commits = ofKind(trace, "committed").map((r) => r.commit);
    expect(commits).toEqual([
      { id: { epoch: 1, idx: 1 }, endOffset: 3 },
      { id: { epoch: 1, idx: 2 }, endOffset: 7 },
      { id: { epoch: 2, idx: 3 }, endOffset: 11 },
    ]);
  });

  it("bills exactly the expected ledger", () => {
    expect(totals(stores.ledger)).toEqual(EXPECTED_TOTALS);
  });

  it("records the past-retention drop exactly once", () => {
    expect(stores.drops.all().map((d) => d.offset)).toEqual(EXPECTED_DROP_OFFSETS);
  });
});

describe("crash at C4 during batch 2 (after commit)", () => {
  const stores = fixtureStores();
  const { trace, crashes } = drain(stores, {
    crash: scriptedCrash({ partition: 0, batchIdx: 2, point: "C4" }),
  });

  it("crashes once and does not replay: the batch is already committed", () => {
    expect(crashes.map((c) => c.point)).toEqual(["C4"]);
    const recoveries = ofKind(trace, "recovered");
    expect(recoveries.map((r) => r.replay)).toEqual([null, null]);
  });

  it("plans the next batch with the new epoch", () => {
    // Batch 2's "committed" result never returns (the crash fires right after the write).
    expect(ofKind(trace, "planned").map((r) => r.plan.id)).toEqual([
      { epoch: 1, idx: 1 },
      { epoch: 1, idx: 2 },
      { epoch: 2, idx: 3 },
    ]);
    expect(stores.batchLogs[0]!.lastCommit()).toEqual({ id: { epoch: 2, idx: 3 }, endOffset: 11 });
  });

  it("bills exactly the expected ledger and drops once", () => {
    expect(totals(stores.ledger)).toEqual(EXPECTED_TOTALS);
    expect(stores.drops.all().map((d) => d.offset)).toEqual(EXPECTED_DROP_OFFSETS);
  });
});

describe("partial writes are durable before the crash", () => {
  it("C2a leaves half the dedup entries written", () => {
    const stores = fixtureStores();
    expect(() => drain(stores, { crash: scriptedCrash({ partition: 0, batchIdx: 2, point: "C2a" }) })).not.toThrow();
    // Batch 2 keeps m4 and m5; the replay found m4's entry (written before the crash) and kept it as its own.
    expect(stores.dedup[0]!.get("m4")?.id).toEqual({ epoch: 1, idx: 2 });
    expect(stores.dedup[0]!.get("m5")?.id).toEqual({ epoch: 1, idx: 2 });
  });

  it("C3a: the replay's CAS rejects the row written before the crash and applies the other", () => {
    const stores = fixtureStores();
    const { trace } = drain(stores, { crash: scriptedCrash({ partition: 0, batchIdx: 2, point: "C3a" }) });
    const sinks = ofKind(trace, "sinkWritten");
    // batch 1 (m1, m2, m3), batch 2 replay (m5 late row rejected, m4 applied), batch 3 (m7, m8).
    // The crashed first attempt never returned a result.
    expect(sinks.map((s) => [s.applied, s.rejected])).toEqual([
      [3, 0],
      [1, 1],
      [2, 0],
    ]);
  });
});
