import { compareBatchId, formatBatchId } from "./batchId.js";
import type { BatchLog, DedupStore, Ledger, Stores } from "./stores/types.js";
import type { BatchId } from "./types.js";

/**
 * PLAN.md invariants:
 *  I1 every sink row's lastApplied <= its partition's last plan id
 *  I2 drained ledger == oracle (checked by the caller; see ledger.ts diffTotals)
 *  I3 no dedup entry id > its partition's last plan id
 *  I4 the committed offset never goes backwards
 */
export type InvariantCode = "I1" | "I2" | "I3" | "I4";

export class InvariantViolation extends Error {
  constructor(
    readonly code: InvariantCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "InvariantViolation";
  }
}

const leq = (a: BatchId, b: BatchId | undefined) => b !== undefined && compareBatchId(a, b) <= 0;

/**
 * Wraps the stores so I1, I3 and I4 are checked on every write. Only writes can
 * break them, so this is equivalent to asserting after every step, at O(1) per write.
 */
export function withInvariants(stores: Stores): Stores {
  const planId = (p: number) => stores.batchLogs[p]!.lastPlan()?.id;

  const batchLogs = stores.batchLogs.map((log, p): BatchLog => ({
    get epoch() {
      return log.epoch;
    },
    bumpEpoch: () => log.bumpEpoch(),
    writePlan(plan) {
      const prev = log.lastPlan();
      if (prev && compareBatchId(plan.id, prev.id) < 0) {
        throw new InvariantViolation("I1", `P${p} plan ${formatBatchId(plan.id)} older than ${formatBatchId(prev.id)}`);
      }
      log.writePlan(plan);
    },
    lastPlan: () => log.lastPlan(),
    commit(id, endOffset) {
      const prev = log.lastCommit();
      if (prev && endOffset < prev.endOffset) {
        throw new InvariantViolation("I4", `P${p} commit offset ${endOffset} < ${prev.endOffset}`);
      }
      log.commit(id, endOffset);
    },
    lastCommit: () => log.lastCommit(),
  }));

  const dedup = stores.dedup.map((d, p): DedupStore => ({
    get: (m) => d.get(m),
    putIfAbsent(m, entry) {
      if (!leq(entry.id, planId(p))) {
        throw new InvariantViolation("I3", `P${p} dedup ${m} ${formatBatchId(entry.id)} > last plan`);
      }
      return d.putIfAbsent(m, entry);
    },
    expire: (now) => d.expire(now),
    entries: () => d.entries(),
  }));

  const ledger: Ledger = {
    casApply(key, delta, id) {
      if (!leq(id, planId(key.partition))) {
        throw new InvariantViolation("I1", `P${key.partition} sink write ${formatBatchId(id)} > last plan`);
      }
      return stores.ledger.casApply(key, delta, id);
    },
    blindAdd(key, delta, id) {
      if (!leq(id, planId(key.partition))) {
        throw new InvariantViolation("I1", `P${key.partition} sink write ${formatBatchId(id)} > last plan`);
      }
      stores.ledger.blindAdd(key, delta, id);
    },
    get: (key) => stores.ledger.get(key),
    rows: () => stores.ledger.rows(),
  };

  return { source: stores.source, batchLogs, dedup, ledger, drops: stores.drops };
}

/** Full scan of I1 and I3, for the end of a run and for tests. */
export function checkInvariants(stores: Stores): void {
  const planId = (p: number) => stores.batchLogs[p]!.lastPlan()?.id;
  for (const row of stores.ledger.rows()) {
    if (!leq(row.lastApplied, planId(row.key.partition))) {
      throw new InvariantViolation("I1", `row P${row.key.partition} ${formatBatchId(row.lastApplied)} > last plan`);
    }
  }
  stores.dedup.forEach((d, p) => {
    for (const [m, entry] of d.entries()) {
      if (!leq(entry.id, planId(p))) {
        throw new InvariantViolation("I3", `P${p} dedup ${m} ${formatBatchId(entry.id)} > last plan`);
      }
    }
  });
}
