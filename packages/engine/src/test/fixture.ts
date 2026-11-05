import type { DeliveryEvent } from "../types.js";

/**
 * Hand-written workload for one partition, 12 records, maxBatch 4 -> 3 batches.
 * Expected totals are literals computed by hand, not by engine code.
 *
 *  off  msg  acct sku        bucket   note
 *   0   m1   A    marketing  h0
 *   1   m2   A    utility    h0
 *   2   m1   A    marketing  h0       dup within batch 1 (second device)
 *   3   m3   B    marketing  h1
 *  ---- batch 2 ----
 *   4   m4   B    utility    h1
 *   5   m2   A    utility    h0       dup across batches (first copy in batch 1)
 *   6   m5   A    marketing  late     delivered 10 days before append
 *   7   m6   B    utility    h1       past retention (sent 36 days before append) -> DropLog
 *  ---- batch 3 ----
 *   8   m7   A    marketing  h1
 *   9   m4   B    utility    h1       dup across batches (first copy in batch 2)
 *  10   m8   B    marketing  h1       same row as m3, different batch
 *  11   m5   A    marketing  late     dup of the late event (first copy in batch 2)
 */

const DAY = 86_400_000;
const HH = 1_800_000;
const T0 = 100 * DAY; // a half-hour boundary
const LATE = T0 - 10 * DAY;

export const MAX_BATCH = 4;
export const MARKETING = 25_000;
export const UTILITY = 8_000;

const price = (sku: string) => (sku === "marketing" ? MARKETING : UTILITY);

function ev(
  offset: number,
  messageId: string,
  deviceId: string,
  account: string,
  sku: string,
  deliveredAt: number,
  sentAt: number = deliveredAt - 1_000,
): DeliveryEvent {
  return {
    messageId,
    deviceId,
    account,
    sku,
    priceMicros: price(sku),
    sentAt,
    deliveredAt,
    appendedAt: T0 + HH + 60_000 + offset * 1_000,
  };
}

export const FIXTURE_EVENTS: readonly DeliveryEvent[] = [
  ev(0, "m1", "d1", "A", "marketing", T0 + 10_000),
  ev(1, "m2", "d1", "A", "utility", T0 + 20_000),
  ev(2, "m1", "d2", "A", "marketing", T0 + 30_000, T0 + 10_000 - 1_000),
  ev(3, "m3", "d1", "B", "marketing", T0 + HH + 10_000),
  ev(4, "m4", "d1", "B", "utility", T0 + HH + 20_000),
  ev(5, "m2", "d2", "A", "utility", T0 + 25_000, T0 + 20_000 - 1_000),
  ev(6, "m5", "d1", "A", "marketing", LATE),
  ev(7, "m6", "d1", "B", "utility", T0 + HH + 30_000, T0 + HH + 60_000 + 7_000 - 36 * DAY),
  ev(8, "m7", "d1", "A", "marketing", T0 + HH + 40_000),
  ev(9, "m4", "d2", "B", "utility", T0 + HH + 45_000, T0 + HH + 20_000 - 1_000),
  ev(10, "m8", "d1", "B", "marketing", T0 + HH + 50_000),
  ev(11, "m5", "d2", "A", "marketing", LATE + 5_000, LATE - 1_000),
];

const h0 = T0 / HH;
const h1 = h0 + 1;
const late = Math.floor(LATE / HH);

/** account|sku|halfHour -> micros, summed across partitions. */
export const EXPECTED_TOTALS: Readonly<Record<string, number>> = {
  [`A|marketing|${h0}`]: 25_000, // m1
  [`A|utility|${h0}`]: 8_000, // m2
  [`B|marketing|${h1}`]: 50_000, // m3 + m8
  [`B|utility|${h1}`]: 8_000, // m4
  [`A|marketing|${late}`]: 25_000, // m5
  [`A|marketing|${h1}`]: 25_000, // m7
};

/** The single past-retention record. */
export const EXPECTED_DROP_OFFSETS = [7];
