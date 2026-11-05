/** Integer micros (1 USD = 1_000_000). Never a float. */
export type Micros = number;

/** Epoch-ms timestamps. All carried on the record; the engine never reads a wall clock. */
export type Millis = number;

/**
 * A delivery event. Price is fixed at send time and carried on the event
 * (PLAN.md, locked decision "Event types").
 */
export interface DeliveryEvent {
  readonly messageId: string;
  readonly deviceId: string;
  readonly account: string;
  readonly sku: string;
  readonly priceMicros: Micros;
  readonly sentAt: Millis;
  readonly deliveredAt: Millis;
  readonly appendedAt: Millis;
}

/** A delivery event once it has a position in the source log. */
export interface LogRecord extends DeliveryEvent {
  readonly partition: number;
  readonly offset: number;
}

/** Ordered lexicographically by (epoch, idx). See batchId.ts. */
export interface BatchId {
  readonly epoch: number;
  readonly idx: number;
}

/** A batch range, fixed forever once written. Offsets are inclusive. */
export interface BatchPlan {
  readonly id: BatchId;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface Commit {
  readonly id: BatchId;
  readonly endOffset: number;
}

/** One writer per row: the partition is part of the key. */
export interface SinkKey {
  readonly account: string;
  readonly sku: string;
  readonly halfHour: number;
  readonly partition: number;
}

export interface LedgerRow {
  readonly key: SinkKey;
  readonly totalMicros: Micros;
  readonly lastApplied: BatchId;
}

export interface DedupEntry {
  /** The batch that kept this messageId. */
  readonly id: BatchId;
  /** appendedAt of the kept copy: record time, so TTL never depends on when the batch ran. */
  readonly seenAt: Millis;
}

export interface DropRecord {
  readonly partition: number;
  readonly offset: number;
  readonly messageId: string;
  readonly batchId: BatchId;
  readonly reason: "pastRetention";
}
