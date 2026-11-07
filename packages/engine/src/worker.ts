import { compareBatchId, formatBatchId } from "./batchId.js";
import { InvariantViolation } from "./invariants.js";
import { CrashSignal, noCrashes, type CrashInjector, type CrashPoint } from "./crash.js";
import type { BatchLog, DedupStore, Stores } from "./stores/types.js";
import { ALL_SAFEGUARDS, type Safeguards } from "./safeguards.js";
import { halfHour, isPastRetention } from "./time.js";
import type { BatchId, BatchPlan, Commit, DedupEntry, LogRecord, Micros, SinkKey } from "./types.js";

/**
 * One worker per partition, running the batch protocol (PLAN.md, "Batch protocol")
 * as a step machine: each step() call does exactly one protocol step, so a
 * scheduler can land a crash between any two of them.
 *
 * Everything on `this` is memory and is lost on a crash. Durable state lives
 * only in the stores. A restart is `new Worker(...)` over the same stores.
 */

export type StepOrder = "dedupThenSink" | "sinkThenDedup";

export type Phase = "recover" | "plan" | "read" | "filter" | "writeDedup" | "aggregate" | "sink" | "commit";

export interface WorkerOptions {
  readonly partition: number;
  readonly stores: Stores;
  readonly maxBatch: number;
  readonly crash?: CrashInjector;
  /** Dedup and sink writes are interchangeable; only plan-first and commit-last are load-bearing. */
  readonly stepOrder?: StepOrder;
  /** All on by default. Each break-it toggle turns one off. */
  readonly safeguards?: Partial<Safeguards>;
  /**
   * Seeded randomness. A correct worker never uses it; it exists for the
   * `nondeterministicBatches` break-it toggle.
   */
  readonly random?: () => number;
}

export type StepResult =
  | { readonly kind: "recovered"; readonly epoch: number; readonly replay: BatchPlan | null }
  | { readonly kind: "idle" }
  | { readonly kind: "planned"; readonly plan: BatchPlan }
  | { readonly kind: "read"; readonly count: number }
  | {
      readonly kind: "filtered";
      readonly kept: number;
      readonly duplicates: number;
      readonly dropped: number;
      /** The records behind the counts, for inspectors. Not part of the trace. */
      readonly decisions: FilterResult;
    }
  | { readonly kind: "dedupWritten"; readonly written: number }
  | { readonly kind: "aggregated"; readonly keys: number }
  | { readonly kind: "sinkWritten"; readonly applied: number; readonly rejected: number }
  | { readonly kind: "committed"; readonly commit: Commit };

export interface WorkerSnapshot {
  readonly partition: number;
  readonly phase: Phase;
  readonly epoch: number;
  readonly plan: BatchPlan | null;
  readonly isReplay: boolean;
}

export interface Delta {
  readonly key: SinkKey;
  readonly delta: Micros;
}

export interface FilterOptions {
  /** Safeguard `dedupStore`. Off: no dedup at all, not even within the batch. */
  readonly useDedup?: boolean;
  /** Safeguard `dedupChecksBatchId`. Off: any existing entry counts as a duplicate. */
  readonly checkBatchId?: boolean;
}

export interface FilterResult {
  readonly kept: LogRecord[];
  readonly duplicates: LogRecord[];
  readonly dropped: LogRecord[];
}

const AFTER_FILTER: Record<StepOrder, readonly Phase[]> = {
  dedupThenSink: ["writeDedup", "aggregate", "sink", "commit"],
  sinkThenDedup: ["aggregate", "sink", "writeDedup", "commit"],
};

/**
 * The filter step, in log order. Pure: decisions depend only on the records,
 * the batch id and the dedup store, never on when the batch runs.
 */
export function filterBatch(
  records: readonly LogRecord[],
  id: BatchId,
  dedupGet: (messageId: string) => DedupEntry | undefined,
  opts: FilterOptions = {},
): FilterResult {
  const useDedup = opts.useDedup ?? true;
  const checkBatchId = opts.checkBatchId ?? true;
  const kept: LogRecord[] = [];
  const duplicates: LogRecord[] = [];
  const dropped: LogRecord[] = [];
  const keptInBatch = new Set<string>();
  for (const rec of records) {
    if (isPastRetention(rec)) {
      dropped.push(rec);
      continue;
    }
    if (!useDedup) {
      kept.push(rec); // break-it: no dedup, every copy is billed
      continue;
    }
    const entry = dedupGet(rec.messageId);
    if (entry) {
      const c = compareBatchId(entry.id, id);
      if (c < 0 || !checkBatchId) {
        // Kept by an earlier batch: a true duplicate.
        duplicates.push(rec);
        continue;
      }
      if (c > 0) {
        throw new InvariantViolation(
          "I3",
          `dedup entry for ${rec.messageId} ${formatBatchId(entry.id)} is newer than batch ${formatBatchId(id)}`,
        );
      }
      // c === 0: our own earlier attempt at this batch. Keep it (subject to the in-batch check).
    }
    if (keptInBatch.has(rec.messageId)) {
      duplicates.push(rec);
      continue;
    }
    keptInBatch.add(rec.messageId);
    kept.push(rec);
  }
  return { kept, duplicates, dropped };
}

function compareSinkKey(a: SinkKey, b: SinkKey): number {
  if (a.account !== b.account) return a.account < b.account ? -1 : 1;
  if (a.sku !== b.sku) return a.sku < b.sku ? -1 : 1;
  if (a.halfHour !== b.halfHour) return a.halfHour - b.halfHour;
  return a.partition - b.partition;
}

/** Sum kept items per SinkKey, in sorted key order. Pure. */
export function aggregate(kept: readonly LogRecord[]): Delta[] {
  const byKey = new Map<string, { key: SinkKey; delta: Micros }>();
  for (const rec of kept) {
    const key: SinkKey = {
      account: rec.account,
      sku: rec.sku,
      halfHour: halfHour(rec.deliveredAt),
      partition: rec.partition,
    };
    const k = `${key.account}|${key.sku}|${key.halfHour}|${key.partition}`;
    const cur = byKey.get(k);
    if (cur) cur.delta += rec.priceMicros;
    else byKey.set(k, { key, delta: rec.priceMicros });
  }
  return [...byKey.values()].sort((a, b) => compareSinkKey(a.key, b.key));
}

export class Worker {
  readonly partition: number;
  private readonly stores: Stores;
  private readonly log: BatchLog;
  private readonly dedup: DedupStore;
  private readonly maxBatch: number;
  private readonly crash: CrashInjector;
  private readonly afterFilter: readonly Phase[];
  private readonly sg: Safeguards;
  private readonly random: (() => number) | undefined;

  // Memory only: discarded with the Worker on a crash.
  private phase: Phase = "recover";
  private plan: BatchPlan | null = null;
  private isReplay = false;
  private records: readonly LogRecord[] = [];
  private kept: readonly LogRecord[] = [];
  private deltas: readonly Delta[] = [];

  constructor(opts: WorkerOptions) {
    if (!Number.isInteger(opts.maxBatch) || opts.maxBatch < 1) throw new RangeError(`bad maxBatch ${opts.maxBatch}`);
    this.partition = opts.partition;
    this.stores = opts.stores;
    this.log = opts.stores.batchLogs[opts.partition]!;
    this.dedup = opts.stores.dedup[opts.partition]!;
    this.maxBatch = opts.maxBatch;
    this.crash = opts.crash ?? noCrashes;
    this.afterFilter = AFTER_FILTER[opts.stepOrder ?? "dedupThenSink"];
    this.sg = { ...ALL_SAFEGUARDS, ...opts.safeguards };
    this.random = opts.random;
    if (!this.sg.deterministicBatches && !this.random) throw new Error("nondeterministicBatches toggle needs randomness");
  }

  snapshot(): WorkerSnapshot {
    return {
      partition: this.partition,
      phase: this.phase,
      epoch: this.log.epoch,
      plan: this.plan,
      isReplay: this.isReplay,
    };
  }

  step(): StepResult {
    switch (this.phase) {
      case "recover":
        return this.recover();
      case "plan":
        return this.planNext();
      case "read":
        return this.read();
      case "filter":
        return this.filter();
      case "writeDedup":
        return this.writeDedup();
      case "aggregate":
        return this.aggregate();
      case "sink":
        return this.sink();
      case "commit":
        return this.commit();
    }
  }

  /** On (re)start: bump the epoch, then replay an uncommitted plan under its ORIGINAL id. */
  private recover(): StepResult {
    const epoch = this.log.bumpEpoch();
    const plan = this.log.lastPlan();
    const commit = this.log.lastCommit();
    if (plan && (!commit || compareBatchId(plan.id, commit.id) > 0)) {
      this.plan = plan; // never re-stamped with the new epoch
      if (!this.sg.replayKeepsBatchId) {
        // break-it: the replay takes the new epoch
        this.plan = { ...this.plan, id: { epoch, idx: plan.id.idx } };
        this.log.writePlan(this.plan);
      }
      if (!this.sg.deterministicBatches) {
        // break-it: ignore the planned range; read whatever is available, up to a random size
        const logEnd = this.stores.source.endOffset(this.partition);
        const size = 1 + Math.floor(this.random!() * this.maxBatch);
        this.plan = { ...this.plan, endOffset: Math.min(logEnd, this.plan.startOffset + size - 1) };
        this.log.writePlan(this.plan);
      }
      this.isReplay = true;
      this.phase = "read";
      return { kind: "recovered", epoch, replay: this.plan };
    }
    this.phase = "plan";
    return { kind: "recovered", epoch, replay: null };
  }

  /** Step 1. Fix the batch range forever, before reading anything. */
  private planNext(): StepResult {
    const start = (this.log.lastCommit()?.endOffset ?? -1) + 1;
    const logEnd = this.stores.source.endOffset(this.partition);
    if (logEnd < start) return { kind: "idle" };
    const plan: BatchPlan = {
      id: { epoch: this.log.epoch, idx: (this.log.lastPlan()?.id.idx ?? 0) + 1 },
      startOffset: start,
      endOffset: Math.min(logEnd, start + this.maxBatch - 1),
    };
    this.log.writePlan(plan);
    if (!this.sg.commitLast) this.log.commit(plan.id, plan.endOffset); // break-it: commit before processing
    this.plan = plan;
    this.isReplay = false;
    this.phase = "read";
    this.crashPoint("C1");
    return { kind: "planned", plan };
  }

  /** Step 2. Exactly the planned range, never "whatever is available now". */
  private read(): StepResult {
    const plan = this.currentPlan();
    this.records = this.stores.source.read(this.partition, plan.startOffset, plan.endOffset);
    const expected = plan.endOffset - plan.startOffset + 1;
    if (this.records.length !== expected) {
      throw new Error(`planned ${expected} records at ${formatBatchId(plan.id)} but read ${this.records.length}`);
    }
    this.phase = "filter";
    return { kind: "read", count: this.records.length };
  }

  /** Step 3. Drop past-retention, skip duplicates, keep our own earlier attempt. */
  private filter(): StepResult {
    const plan = this.currentPlan();
    const { kept, duplicates, dropped } = filterBatch(this.records, plan.id, (m) => this.dedup.get(m), {
      useDedup: this.sg.dedupStore,
      checkBatchId: this.sg.dedupChecksBatchId,
    });
    for (const rec of dropped) {
      this.stores.drops.record({
        partition: rec.partition,
        offset: rec.offset,
        messageId: rec.messageId,
        batchId: plan.id,
        reason: "pastRetention",
      });
    }
    this.kept = kept;
    this.phase = this.afterFilter[0]!;
    return {
      kind: "filtered",
      kept: kept.length,
      duplicates: duplicates.length,
      dropped: dropped.length,
      decisions: { kept, duplicates, dropped },
    };
  }

  /** Step 4. putIfAbsent per kept item. C2a halfway, C2 after. */
  private writeDedup(): StepResult {
    const id = this.currentPlan().id;
    const half = Math.floor(this.kept.length / 2);
    let written = 0;
    for (const [i, rec] of this.kept.entries()) {
      if (i === half) this.crashPoint("C2a");
      if (!this.sg.dedupStore) continue; // break-it: no dedup writes
      if (this.dedup.putIfAbsent(rec.messageId, { id, seenAt: rec.appendedAt })) written++;
    }
    this.advance("writeDedup");
    this.crashPoint("C2");
    return { kind: "dedupWritten", written };
  }

  /** Step 5. Pure. */
  private aggregate(): StepResult {
    this.deltas = aggregate(this.kept);
    this.advance("aggregate");
    return { kind: "aggregated", keys: this.deltas.length };
  }

  /** Step 6. CAS per row in sorted key order. C3a halfway, C3 after. */
  private sink(): StepResult {
    const id = this.currentPlan().id;
    const half = Math.floor(this.deltas.length / 2);
    let applied = 0;
    let rejected = 0;
    for (const [i, { key, delta }] of this.deltas.entries()) {
      if (i === half) this.crashPoint("C3a");
      if (!this.sg.casSink) {
        this.stores.ledger.blindAdd(key, delta, id); // break-it: no CAS
        applied++;
      } else if (this.stores.ledger.casApply(key, delta, id) === "applied") applied++;
      else rejected++;
    }
    this.advance("sink");
    this.crashPoint("C3");
    return { kind: "sinkWritten", applied, rejected };
  }

  /**
   * Step 7. Commit last. C4 after.
   *
   * Then expire dedup entries against this batch's record-time watermark (its
   * largest appendedAt), never the processing clock. appendedAt is non-decreasing
   * in log order, so any later copy of an expired message has
   * appendedAt - sentAt > 30 days and is dropped as past-retention anyway.
   * Expiring only after the commit means a replay never sees fewer entries than
   * its first attempt did.
   */
  private commit(): StepResult {
    const plan = this.currentPlan();
    this.log.commit(plan.id, plan.endOffset);
    const watermark = this.records.reduce((m, r) => Math.max(m, r.appendedAt), -Infinity);
    if (watermark > -Infinity) this.dedup.expire(watermark);
    this.phase = "plan";
    this.crashPoint("C4");
    return { kind: "committed", commit: { id: plan.id, endOffset: plan.endOffset } };
  }

  private advance(from: Phase): void {
    this.phase = this.afterFilter[this.afterFilter.indexOf(from) + 1]!;
  }

  private currentPlan(): BatchPlan {
    if (!this.plan) throw new Error(`P${this.partition}: no plan in phase ${this.phase}`);
    return this.plan;
  }

  private crashPoint(point: CrashPoint): void {
    const ctx = { partition: this.partition, batchId: this.currentPlan().id, isReplay: this.isReplay };
    if (this.crash.shouldCrash(point, ctx)) throw new CrashSignal(point, ctx);
  }
}
