import {
  checkInvariants,
  diffTotals,
  InvariantViolation,
  ledgerTotals,
  simConfig,
  Simulation,
  type SimOptions,
  type SimOverrides,
  type Stores,
  type TotalsDiff,
} from "@eob/engine";
import { computeExpected, eventKey } from "@eob/oracle";

export interface SeedResult {
  readonly seed: number;
  readonly ok: boolean;
  readonly drained: boolean;
  readonly crashes: number;
  readonly events: number;
  /** Engine ledger vs oracle (I2). */
  readonly diff: TotalsDiff;
  readonly dropsMatch: boolean;
  readonly violation: string | null;
  /** Last trace lines, when tracing was on. */
  readonly trace: readonly string[];
}

/** `messageId|deviceId|appendedAt` for every DropLog entry, looked up in the source log. */
export function engineDropKeys(stores: Stores): Set<string> {
  const keys = new Set<string>();
  for (const d of stores.drops.all()) {
    const rec = stores.source.read(d.partition, d.offset, d.offset)[0];
    if (rec) keys.add(eventKey(rec));
  }
  return keys;
}

const setsEqual = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((k) => b.has(k));

/**
 * One seed: generate, run until drained (I1/I3/I4 checked on every write),
 * then I2: ledger and DropLog against the oracle, which only sees the
 * generated events, never the pipeline.
 */
export function runSeed(seed: number, overrides: SimOverrides = {}, opts: SimOptions = {}, traceTail = 0): SeedResult {
  const sim = new Simulation(simConfig(seed, overrides), { ...opts, trace: opts.trace ?? traceTail > 0 });
  let violation: string | null = null;
  try {
    sim.run();
    checkInvariants(sim.stores);
  } catch (e) {
    if (!(e instanceof InvariantViolation)) throw e;
    violation = e.message;
  }
  const expected = computeExpected(sim.workload.events);
  const diff = diffTotals(ledgerTotals(sim.stores.ledger), expected.totals);
  const dropsMatch = setsEqual(engineDropKeys(sim.stores), expected.drops);
  const drained = sim.drained;
  return {
    seed,
    ok: drained && violation === null && diff.matches && dropsMatch,
    drained,
    crashes: sim.crashes,
    events: sim.eventsProcessed,
    diff,
    dropsMatch,
    violation,
    trace: traceTail > 0 ? sim.trace.slice(-traceTail) : [],
  };
}
