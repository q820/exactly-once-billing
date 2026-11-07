import { diffTotals, ledgerTotals, simConfig, Simulation } from "@eob/engine";
import { computeExpected } from "@eob/oracle";
import { describe, expect, it } from "vitest";
import { runSeed } from "./verify.js";

describe("ledger == oracle (I2)", () => {
  it("with no crashes, default workload (M2 done-criterion)", () => {
    const r = runSeed(1);
    expect(r.crashes).toBe(0);
    expect(r.diff.mismatched).toEqual([]);
    expect(r.dropsMatch).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.diff.rows.length).toBeGreaterThan(100);
  });

  it.each([2, 3, 4, 5, 6])("with random crashes (p=0.05), seed %i", (seed) => {
    const r = runSeed(seed, { workload: { messages: 1_000 } }, { crashProbability: 0.05 });
    expect(r.crashes).toBeGreaterThan(10);
    expect(r.violation).toBeNull();
    expect(r.diff.mismatched).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("sinkThenDedup under crashes also matches", () => {
    const r = runSeed(9, { workload: { messages: 1_000 }, stepOrder: "sinkThenDedup" }, { crashProbability: 0.05 });
    expect(r.ok).toBe(true);
  });

  it("small batches, long restarts", () => {
    const r = runSeed(10, { workload: { messages: 1_000 }, maxBatch: 3, restartDelayMs: [60_000, 600_000] }, { crashProbability: 0.1 });
    expect(r.ok).toBe(true);
  });
});

describe("the oracle can disagree with the engine", () => {
  it("detects a tampered ledger", () => {
    const sim = new Simulation(simConfig(1, { workload: { messages: 200 } }), { checkInvariants: false });
    sim.run();
    const expected = computeExpected(sim.workload.events);
    expect(diffTotals(ledgerTotals(sim.stores.ledger), expected.totals).matches).toBe(true);
    const row = sim.stores.ledger.rows()[0]!;
    sim.stores.ledger.blindAdd(row.key, 4_000, row.lastApplied);
    const after = diffTotals(ledgerTotals(sim.stores.ledger), expected.totals);
    expect([after.overMicros, after.underMicros, after.mismatched.length]).toEqual([4_000, 0, 1]);
  });

  it("covers late events in old buckets and past-retention drops", () => {
    const sim = new Simulation(simConfig(1));
    const expected = computeExpected(sim.workload.events);
    const halfHours = [...expected.totals.keys()].map((k) => Number(k.split("|")[2]));
    const start = Math.floor(sim.config.workload.startMs / 1_800_000);
    expect(halfHours.some((h) => h < start - 48)).toBe(true); // > 1 day old
    expect(expected.drops.size).toBeGreaterThan(0);
  });
});
