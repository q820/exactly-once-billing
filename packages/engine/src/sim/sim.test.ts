import { describe, expect, it } from "vitest";
import { partitionFor } from "../hash.js";
import { ledgerTotals } from "../ledger.js";
import { DAY_MS, RETENTION_MS } from "../time.js";
import { EventQueue } from "./queue.js";
import { mulberry32 } from "./prng.js";
import { Simulation, simConfig } from "./simulation.js";
import { DEFAULT_WORKLOAD, generateWorkload } from "./workload.js";

describe("PRNG and queue", () => {
  it("mulberry32 is reproducible and seed-sensitive", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(mulberry32(43).next()).not.toBe(xs[0]);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("pops by time, then insertion order", () => {
    const q = new EventQueue<string>();
    q.push(5, "c");
    q.push(1, "a");
    q.push(5, "d");
    q.push(1, "b");
    q.push(3, "x");
    const out: string[] = [];
    for (let e = q.pop(); e; e = q.pop()) out.push(e.value);
    expect(out).toEqual(["a", "b", "x", "c", "d"]);
  });
});

describe("workload generator (defaults)", () => {
  const w = generateWorkload(7);
  const byMessage = new Map<string, typeof w.events>();
  for (const e of w.events) byMessage.set(e.messageId, [...(byMessage.get(e.messageId) ?? []), e]);
  const count = (k: string) => [...w.kindOf.values()].filter((v) => v === k).length;

  it("is a pure function of the seed", () => {
    expect(generateWorkload(7)).toEqual(w);
    expect(generateWorkload(8).events).not.toEqual(w.events);
  });

  it("has about 5,000 messages over 20 accounts x 3 SKUs", () => {
    expect(byMessage.size).toBe(5_000);
    expect(new Set(w.events.map((e) => e.account)).size).toBe(20);
    expect(new Set(w.events.map((e) => e.sku)).size).toBe(3);
  });

  it("appends in non-decreasing appendedAt order (expiry safety depends on it)", () => {
    for (let i = 1; i < w.events.length; i++) {
      expect(w.events[i]!.appendedAt).toBeGreaterThanOrEqual(w.events[i - 1]!.appendedAt);
    }
  });

  it("gives every copy of a message the same price, account, sku and sentAt", () => {
    for (const copies of byMessage.values()) {
      const [first, ...rest] = copies;
      for (const c of rest) {
        expect([c.account, c.sku, c.priceMicros, c.sentAt]).toEqual([
          first!.account,
          first!.sku,
          first!.priceMicros,
          first!.sentAt,
        ]);
      }
    }
  });

  it("hits the duplicate, late and past-retention rates", () => {
    const multi = [...byMessage.values()].filter((c) => new Set(c.map((e) => e.deviceId)).size > 1).length;
    expect(multi / 5_000).toBeGreaterThan(0.13);
    expect(multi / 5_000).toBeLessThan(0.17);
    expect(count("late") / 5_000).toBeGreaterThan(0.04);
    expect(count("late") / 5_000).toBeLessThan(0.06);
    expect(count("pastRetention")).toBeGreaterThan(5);
    expect(count("pastRetention")).toBeLessThan(35);
  });

  it("puts late events 1-29 days back and past-retention beyond 30 days", () => {
    for (const e of w.events) {
      const kind = w.kindOf.get(e.messageId);
      if (kind === "late") {
        const lag = e.appendedAt - e.deliveredAt;
        expect(lag).toBeGreaterThanOrEqual(DAY_MS - 1);
      }
      if (kind === "pastRetention") expect(e.appendedAt - e.sentAt).toBeGreaterThan(RETENTION_MS);
      if (kind !== "pastRetention") expect(e.appendedAt - e.sentAt).toBeLessThanOrEqual(RETENTION_MS);
      expect(e.deliveredAt).toBeLessThanOrEqual(e.appendedAt);
    }
  });

  it("spreads copies so some share a batch and some don't", () => {
    const gaps = [...byMessage.values()].filter((c) => c.length > 1).map((c) => c.at(-1)!.appendedAt - c[0]!.appendedAt);
    expect(gaps.some((g) => g < 60_000)).toBe(true);
    expect(gaps.some((g) => g > 5 * 60_000)).toBe(true);
  });

  it("routes all copies of a message to one partition", () => {
    for (const [id] of byMessage) expect(partitionFor(id, 8)).toBe(partitionFor(id, 8));
    expect(new Set([...byMessage.keys()].map((id) => partitionFor(id, 8))).size).toBe(8);
  });

  it("respects overrides", () => {
    expect(new Set(generateWorkload(1, { ...DEFAULT_WORKLOAD, messages: 50 }).events.map((e) => e.messageId)).size).toBe(50);
  });
});

describe("simulation", () => {
  const small = simConfig(11, { workload: { messages: 400 } });

  it("drains with no crashes, all 8 partitions used", () => {
    const sim = new Simulation(small);
    const s = sim.run();
    expect(s.drained).toBe(true);
    expect(s.crashes).toBe(0);
    for (const lane of sim.laneStates()) {
      expect(lane.committedEnd).toBe(lane.logEnd);
      expect(lane.logEnd).toBeGreaterThan(0);
    }
  });

  it("is deterministic: the same seed gives a byte-identical trace twice", () => {
    const run = () => {
      const sim = new Simulation(small, { crashProbability: 0.05, trace: true });
      sim.run();
      return { trace: sim.trace.join("\n"), ledger: JSON.stringify(sim.stores.ledger.rows()) };
    };
    const a = run();
    const b = run();
    expect(a.trace.length).toBeGreaterThan(1_000);
    expect(b.trace).toBe(a.trace);
    expect(b.ledger).toBe(a.ledger);
  });

  it("a crash seed changes only the crashes: same workload, same totals, reproducible", () => {
    const run = (crashSeed?: number) => {
      const sim = new Simulation(small, { crashProbability: 0.05, trace: true, ...(crashSeed === undefined ? {} : { crashSeed }) });
      sim.run();
      return { trace: sim.trace.join("\n"), events: sim.workload.events, totals: ledgerTotals(sim.stores.ledger) };
    };
    const base = run();
    expect(run(11).trace).toBe(base.trace); // defaults to the run seed
    const other = run(12345);
    expect(other.trace).not.toBe(base.trace);
    expect(other.events).toEqual(base.events);
    expect(other.totals).toEqual(base.totals);
    expect(run(12345).trace).toBe(other.trace);
  });

  it("different seeds give different traces", () => {
    const trace = (seed: number) => {
      const sim = new Simulation(simConfig(seed, { workload: { messages: 100 } }), { trace: true });
      sim.run();
      return sim.trace.join("\n");
    };
    expect(trace(1)).not.toBe(trace(2));
  });

  it("drains under random crashes with I1/I3/I4 checked on every write", () => {
    const sim = new Simulation(small, { crashProbability: 0.1 });
    const s = sim.run();
    expect(s.drained).toBe(true);
    expect(s.crashes).toBeGreaterThan(20);
  });

  it("restarts after the Platform delay and bumps the epoch", () => {
    const events: { type: string; t: number; restartAt?: number; partition?: number }[] = [];
    const sim = new Simulation(small, { crashProbability: 0.1, onEvent: (e) => events.push(e) });
    sim.run();
    const crash = events.find((e) => e.type === "crash")!;
    const restart = events.find((e) => e.type === "restart" && e.partition === crash.partition && e.t >= crash.t)!;
    expect(restart.t).toBe(crash.restartAt);
    expect(restart.t - crash.t).toBeGreaterThanOrEqual(5_000);
    expect(restart.t - crash.t).toBeLessThanOrEqual(30_000);
    expect(sim.laneStates().some((l) => l.epoch > 1)).toBe(true);
  });

  it("crashes don't change the workload or the totals", () => {
    const clean = new Simulation(small);
    clean.run();
    const crashed = new Simulation(small, { crashProbability: 0.1 });
    crashed.run();
    expect(crashed.workload).toEqual(clean.workload);
    expect(ledgerTotals(crashed.stores.ledger)).toEqual(ledgerTotals(clean.stores.ledger));
  });
});
