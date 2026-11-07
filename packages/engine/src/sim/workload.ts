import { DAY_MS, MINUTE_MS, RETENTION_MS } from "../time.js";
import type { DeliveryEvent } from "../types.js";
import { deriveSeed, mulberry32 } from "./prng.js";

/** PLAN.md, "Workload generator". All adjustable. */
export interface WorkloadConfig {
  readonly accounts: number;
  readonly messages: number;
  /** Sim time of the first append. A fixed constant: the engine never reads a wall clock. */
  readonly startMs: number;
  /** Append window. */
  readonly durationMs: number;
  /** Share of messages delivered to 2-3 devices. */
  readonly multiDeviceRate: number;
  /** Share of messages with one infra retry (an identical re-append). */
  readonly infraRetryRate: number;
  /** Share delivered 1-29 days before they are appended (phones coming online late). */
  readonly lateRate: number;
  /** Share sent more than 30 days before they are appended (go to the DropLog). */
  readonly pastRetentionRate: number;
  /** How far after the first copy other copies are appended. */
  readonly copySpreadMs: number;
}

/** Integer micros per delivery. */
export const SKU_PRICES: Readonly<Record<string, number>> = {
  marketing: 25_000,
  utility: 4_000,
  authentication: 3_500,
};
export const SKUS = Object.keys(SKU_PRICES);

/** 2026-10-01T00:00:00Z. */
export const SIM_START_MS = 1_790_812_800_000;

export const DEFAULT_WORKLOAD: WorkloadConfig = {
  accounts: 20,
  messages: 5_000,
  startMs: SIM_START_MS,
  durationMs: 2 * 60 * MINUTE_MS,
  multiDeviceRate: 0.15,
  infraRetryRate: 0.03,
  lateRate: 0.05,
  pastRetentionRate: 0.003,
  copySpreadMs: 15 * MINUTE_MS,
};

export type MessageKind = "normal" | "late" | "pastRetention";

export interface Workload {
  /** In append order, non-decreasing appendedAt. The producer appends them exactly in this order. */
  readonly events: readonly DeliveryEvent[];
  readonly kindOf: ReadonlyMap<string, MessageKind>;
  readonly endMs: number;
}

/** A pure function of (seed, config). */
export function generateWorkload(seed: number, config: WorkloadConfig = DEFAULT_WORKLOAD): Workload {
  const rng = mulberry32(deriveSeed(seed, "workload"));
  const pending: { event: DeliveryEvent; order: number }[] = [];
  const kindOf = new Map<string, MessageKind>();
  const width = String(config.messages - 1).length;
  let order = 0;
  const push = (event: DeliveryEvent) => pending.push({ event, order: order++ });

  for (let i = 0; i < config.messages; i++) {
    const messageId = `m${String(i).padStart(width, "0")}`;
    const account = `acct${String(rng.int(1, config.accounts)).padStart(2, "0")}`;
    const sku = rng.pick(SKUS);
    const appendedAt = config.startMs + rng.int(0, config.durationMs - 1);

    let kind: MessageKind = "normal";
    const r = rng.next();
    if (r < config.pastRetentionRate) kind = "pastRetention";
    else if (r < config.pastRetentionRate + config.lateRate) kind = "late";
    kindOf.set(messageId, kind);

    let sentAt: number;
    let deliveredAt: number;
    if (kind === "pastRetention") {
      sentAt = appendedAt - RETENTION_MS - rng.int(MINUTE_MS, 5 * DAY_MS);
      deliveredAt = sentAt + rng.int(1_000, 10 * DAY_MS);
    } else if (kind === "late") {
      deliveredAt = appendedAt - rng.int(DAY_MS, 29 * DAY_MS);
      sentAt = deliveredAt - rng.int(1_000, 60_000);
    } else {
      deliveredAt = appendedAt - rng.int(0, 30_000);
      sentAt = deliveredAt - rng.int(1_000, 120_000);
    }

    const first: DeliveryEvent = {
      messageId,
      deviceId: "d1",
      account,
      sku,
      priceMicros: SKU_PRICES[sku]!,
      sentAt,
      deliveredAt,
      appendedAt,
    };
    push(first);

    // Every copy shares messageId, account, sku, price and sentAt; only the device,
    // delivery time and append position differ.
    if (rng.chance(config.multiDeviceRate)) {
      const extra = rng.int(1, 2);
      for (let d = 2; d <= extra + 1; d++) {
        push({
          ...first,
          deviceId: `d${d}`,
          deliveredAt: deliveredAt + rng.int(0, 5_000),
          appendedAt: appendedAt + rng.int(0, config.copySpreadMs),
        });
      }
    }
    if (rng.chance(config.infraRetryRate)) {
      push({ ...first, appendedAt: appendedAt + rng.int(1_000, 5 * MINUTE_MS) });
    }
  }

  pending.sort((a, b) => a.event.appendedAt - b.event.appendedAt || a.order - b.order);
  const events = pending.map((p) => p.event);
  return { events, kindOf, endMs: events.at(-1)?.appendedAt ?? config.startMs };
}
