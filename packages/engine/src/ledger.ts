import type { Ledger } from "./stores/types.js";
import type { Micros } from "./types.js";

/** `account|sku|halfHour` -> micros, summed across partitions (invoices sum across partitions). */
export function ledgerTotals(ledger: Ledger): Map<string, Micros> {
  const out = new Map<string, Micros>();
  for (const { key, totalMicros } of ledger.rows()) {
    const k = `${key.account}|${key.sku}|${key.halfHour}`;
    out.set(k, (out.get(k) ?? 0) + totalMicros);
  }
  return out;
}

export interface TotalsDiffRow {
  readonly key: string;
  readonly actual: Micros;
  readonly expected: Micros;
  /** actual - expected: positive = over-billed. */
  readonly diff: Micros;
}

export interface TotalsDiff {
  readonly rows: readonly TotalsDiffRow[];
  readonly mismatched: readonly TotalsDiffRow[];
  readonly overMicros: Micros;
  readonly underMicros: Micros;
  readonly matches: boolean;
}

export function diffTotals(actual: ReadonlyMap<string, Micros>, expected: ReadonlyMap<string, Micros>): TotalsDiff {
  const keys = [...new Set([...actual.keys(), ...expected.keys()])].sort();
  const rows = keys.map((key) => {
    const a = actual.get(key) ?? 0;
    const e = expected.get(key) ?? 0;
    return { key, actual: a, expected: e, diff: a - e };
  });
  const mismatched = rows.filter((r) => r.diff !== 0);
  const overMicros = mismatched.reduce((s, r) => s + Math.max(0, r.diff), 0);
  const underMicros = mismatched.reduce((s, r) => s + Math.max(0, -r.diff), 0);
  return { rows, mismatched, overMicros, underMicros, matches: mismatched.length === 0 };
}
