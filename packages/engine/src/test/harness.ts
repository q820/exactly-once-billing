import { CrashSignal, noCrashes, type CrashInjector } from "../crash.js";
import { createMemoryStores } from "../stores/memory.js";
import type { Safeguards } from "../safeguards.js";
import type { Ledger, Stores } from "../stores/types.js";
import type { DeliveryEvent } from "../types.js";
import { Worker, type StepOrder, type StepResult } from "../worker.js";
import { FIXTURE_EVENTS, MAX_BATCH } from "./fixture.js";

export function fixtureStores(events: readonly DeliveryEvent[] = FIXTURE_EVENTS): Stores {
  const stores = createMemoryStores(1);
  for (const e of events) stores.source.append(e);
  return stores;
}

export interface DrainResult {
  readonly trace: StepResult[];
  readonly crashes: CrashSignal[];
}

/**
 * Test stand-in for M2's scheduler + Platform: step one worker until idle; on a
 * crash, discard it and start a fresh Worker over the same stores.
 */
export function drain(
  stores: Stores,
  opts: {
    crash?: CrashInjector;
    stepOrder?: StepOrder;
    partition?: number;
    maxBatch?: number;
    safeguards?: Partial<Safeguards>;
    random?: () => number;
  } = {},
): DrainResult {
  const make = () =>
    new Worker({
      partition: opts.partition ?? 0,
      stores,
      maxBatch: opts.maxBatch ?? MAX_BATCH,
      crash: opts.crash ?? noCrashes,
      stepOrder: opts.stepOrder ?? "dedupThenSink",
      ...(opts.safeguards ? { safeguards: opts.safeguards } : {}),
      ...(opts.random ? { random: opts.random } : {}),
    });
  const trace: StepResult[] = [];
  const crashes: CrashSignal[] = [];
  let worker = make();
  for (let steps = 0; steps < 10_000; steps++) {
    try {
      const r = worker.step();
      trace.push(r);
      if (r.kind === "idle") return { trace, crashes };
    } catch (e) {
      if (!(e instanceof CrashSignal)) throw e;
      crashes.push(e);
      worker = make();
    }
  }
  throw new Error("drain did not reach idle");
}

/** account|sku|halfHour -> micros, summed across partitions. Test-side, not engine code. */
export function totals(ledger: Ledger): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { key, totalMicros } of ledger.rows()) {
    const k = `${key.account}|${key.sku}|${key.halfHour}`;
    out[k] = (out[k] ?? 0) + totalMicros;
  }
  return out;
}

export const kinds = (trace: StepResult[]) => trace.map((r) => r.kind);
export const ofKind = <K extends StepResult["kind"]>(trace: StepResult[], kind: K) =>
  trace.filter((r): r is Extract<StepResult, { kind: K }> => r.kind === kind);
