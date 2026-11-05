import type {
  BatchId,
  BatchPlan,
  Commit,
  DedupEntry,
  DeliveryEvent,
  DropRecord,
  LedgerRow,
  LogRecord,
  Micros,
  Millis,
  SinkKey,
} from "../types.js";

/**
 * The five durable stores (PLAN.md, "Store interfaces"). A crash wipes worker
 * memory but never these. Each method call is atomic.
 */

export interface SourceLog {
  readonly partitions: number;
  /** Routes by hash(messageId) % P and assigns the next offset in that partition. */
  append(event: DeliveryEvent): LogRecord;
  /** Deterministic: the same range always returns the same records. */
  read(partition: number, start: number, endInclusive: number): readonly LogRecord[];
  /** Offset of the last record, or -1 if the partition is empty. */
  endOffset(partition: number): number;
}

/** Per partition. */
export interface BatchLog {
  readonly epoch: number;
  bumpEpoch(): number;
  writePlan(plan: BatchPlan): void;
  lastPlan(): BatchPlan | null;
  commit(id: BatchId, endOffset: number): void;
  lastCommit(): Commit | null;
}

/** Per partition. */
export interface DedupStore {
  get(messageId: string): DedupEntry | undefined;
  /** Returns false (and changes nothing) if the key already exists. */
  putIfAbsent(messageId: string, entry: DedupEntry): boolean;
  /** Removes entries whose seenAt + TTL < now. Returns how many were removed. */
  expire(now: Millis): number;
  entries(): ReadonlyMap<string, DedupEntry>;
}

export type CasResult = "applied" | "rejected";

/** The sink. */
export interface Ledger {
  /** Applies delta only if row.lastApplied < id. Atomic for one row. */
  casApply(key: SinkKey, delta: Micros, id: BatchId): CasResult;
  rows(): readonly LedgerRow[];
}

/** Past-retention events. Idempotent per (partition, offset), so a replay can't record a drop twice. */
export interface DropLog {
  /** Returns false if this (partition, offset) was already recorded. */
  record(drop: DropRecord): boolean;
  all(): readonly DropRecord[];
}

export interface Clock {
  now(): Millis;
}

export interface Stores {
  readonly source: SourceLog;
  readonly batchLogs: readonly BatchLog[];
  readonly dedup: readonly DedupStore[];
  readonly ledger: Ledger;
  readonly drops: DropLog;
}
