import { compareBatchId } from "../batchId.js";
import { partitionFor } from "../hash.js";
import { RETENTION_MS } from "../time.js";
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
import type { BatchLog, CasResult, DedupStore, DropLog, Ledger, SourceLog, Stores } from "./types.js";

export class MemorySourceLog implements SourceLog {
  private readonly logs: LogRecord[][];

  constructor(readonly partitions: number) {
    this.logs = Array.from({ length: partitions }, () => []);
  }

  append(event: DeliveryEvent): LogRecord {
    const partition = partitionFor(event.messageId, this.partitions);
    const log = this.logs[partition]!;
    const rec: LogRecord = Object.freeze({ ...event, partition, offset: log.length });
    log.push(rec);
    return rec;
  }

  read(partition: number, start: number, endInclusive: number): readonly LogRecord[] {
    return this.logs[partition]!.slice(start, endInclusive + 1);
  }

  endOffset(partition: number): number {
    return this.logs[partition]!.length - 1;
  }
}

export class MemoryBatchLog implements BatchLog {
  private _epoch = 0;
  private plan: BatchPlan | null = null;
  private committed: Commit | null = null;

  get epoch(): number {
    return this._epoch;
  }

  bumpEpoch(): number {
    return ++this._epoch;
  }

  writePlan(plan: BatchPlan): void {
    this.plan = Object.freeze({ ...plan });
  }

  lastPlan(): BatchPlan | null {
    return this.plan;
  }

  commit(id: BatchId, endOffset: number): void {
    this.committed = Object.freeze({ id, endOffset });
  }

  lastCommit(): Commit | null {
    return this.committed;
  }
}

export class MemoryDedupStore implements DedupStore {
  private readonly map = new Map<string, DedupEntry>();

  get(messageId: string): DedupEntry | undefined {
    return this.map.get(messageId);
  }

  putIfAbsent(messageId: string, entry: DedupEntry): boolean {
    if (this.map.has(messageId)) return false;
    this.map.set(messageId, Object.freeze({ ...entry }));
    return true;
  }

  expire(now: Millis): number {
    let removed = 0;
    for (const [id, entry] of this.map) {
      if (entry.seenAt + RETENTION_MS < now) {
        this.map.delete(id);
        removed++;
      }
    }
    return removed;
  }

  entries(): ReadonlyMap<string, DedupEntry> {
    return this.map;
  }
}

export function sinkKeyString(k: SinkKey): string {
  return `${k.account}|${k.sku}|${k.halfHour}|${k.partition}`;
}

export class MemoryLedger implements Ledger {
  private readonly map = new Map<string, LedgerRow>();

  casApply(key: SinkKey, delta: Micros, id: BatchId): CasResult {
    if (!Number.isSafeInteger(delta)) throw new RangeError(`delta must be integer micros, got ${delta}`);
    const k = sinkKeyString(key);
    const row = this.map.get(k);
    if (row && compareBatchId(row.lastApplied, id) >= 0) return "rejected";
    const totalMicros = (row?.totalMicros ?? 0) + delta;
    if (!Number.isSafeInteger(totalMicros)) throw new RangeError(`row total overflowed: ${k}`);
    this.map.set(k, Object.freeze({ key: Object.freeze({ ...key }), totalMicros, lastApplied: id }));
    return "applied";
  }

  rows(): readonly LedgerRow[] {
    return [...this.map.values()];
  }
}

export class MemoryDropLog implements DropLog {
  private readonly map = new Map<string, DropRecord>();

  record(drop: DropRecord): boolean {
    const k = `${drop.partition}:${drop.offset}`;
    if (this.map.has(k)) return false;
    this.map.set(k, Object.freeze({ ...drop }));
    return true;
  }

  all(): readonly DropRecord[] {
    return [...this.map.values()];
  }
}

export function createMemoryStores(partitions: number): Stores {
  if (!Number.isInteger(partitions) || partitions < 1) throw new RangeError(`bad partition count ${partitions}`);
  return {
    source: new MemorySourceLog(partitions),
    batchLogs: Array.from({ length: partitions }, () => new MemoryBatchLog()),
    dedup: Array.from({ length: partitions }, () => new MemoryDedupStore()),
    ledger: new MemoryLedger(),
    drops: new MemoryDropLog(),
  };
}
