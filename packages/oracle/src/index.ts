/**
 * The oracle: the expected ledger computed straight from the events, with no
 * pipeline involved (PLAN.md, "Oracle"). It shares no code with @eob/engine
 * (enforced by lint) and restates the billing rules from scratch, so it can
 * disagree with the engine.
 */

export interface OracleEvent {
  readonly messageId: string;
  readonly deviceId: string;
  readonly account: string;
  readonly sku: string;
  readonly priceMicros: number;
  readonly sentAt: number;
  readonly deliveredAt: number;
  readonly appendedAt: number;
}

export interface OracleResult {
  /** `account|sku|halfHour` -> integer micros. */
  readonly totals: ReadonlyMap<string, number>;
  /** `messageId|deviceId|appendedAt` of every past-retention event. */
  readonly drops: ReadonlySet<string>;
}

const RETENTION_MS = 35 * 24 * 60 * 60 * 1000;
const HALF_HOUR_MS = 30 * 60 * 1000;

export const eventKey = (e: OracleEvent) => `${e.messageId}|${e.deviceId}|${e.appendedAt}`;

/** `events` must be in append (log) order. */
export function computeExpected(events: Iterable<OracleEvent>): OracleResult {
  const totals = new Map<string, number>();
  const drops = new Set<string>();
  const billed = new Set<string>();
  for (const e of events) {
    if (e.appendedAt - e.sentAt > RETENTION_MS) {
      drops.add(eventKey(e)); // never billed, and never counts as the first copy
      continue;
    }
    if (billed.has(e.messageId)) continue; // keep only the first copy of each message
    billed.add(e.messageId);
    const key = `${e.account}|${e.sku}|${Math.floor(e.deliveredAt / HALF_HOUR_MS)}`;
    totals.set(key, (totals.get(key) ?? 0) + e.priceMicros);
  }
  return { totals, drops };
}
