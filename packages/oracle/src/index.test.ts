import { describe, expect, it } from "vitest";
import { computeExpected, type OracleEvent } from "./index.js";

const DAY = 86_400_000;
const HH = 1_800_000;
const T = 1000 * HH;

const e = (messageId: string, over: Partial<OracleEvent> = {}): OracleEvent => ({
  messageId,
  deviceId: "d1",
  account: "A",
  sku: "utility",
  priceMicros: 4_000,
  sentAt: T,
  deliveredAt: T + 1,
  appendedAt: T + 2,
  ...over,
});

describe("oracle", () => {
  it("bills the first copy of each message into its delivery half-hour", () => {
    const r = computeExpected([
      e("m1"),
      e("m1", { deviceId: "d2", deliveredAt: T + HH }), // later copy, different bucket: ignored
      e("m2", { sku: "marketing", priceMicros: 25_000, deliveredAt: T - 10 * DAY }),
    ]);
    expect(Object.fromEntries(r.totals)).toEqual({
      [`A|utility|${T / HH}`]: 4_000,
      [`A|marketing|${(T - 10 * DAY) / HH}`]: 25_000,
    });
    expect(r.drops.size).toBe(0);
  });

  it("drops past-retention copies without letting them claim the message", () => {
    const old = T - 35 * DAY - 1;
    const r = computeExpected([
      e("m1", { sentAt: old, deliveredAt: old + 5 }), // past retention: dropped
      e("m1", { sentAt: old, deliveredAt: old + 5, deviceId: "d2" }), // also past retention
    ]);
    expect(r.totals.size).toBe(0);
    expect(r.drops.size).toBe(2);
  });

  it("keeps an event exactly at the 35-day edge", () => {
    const r = computeExpected([e("m1", { sentAt: T + 2 - 35 * DAY })]);
    expect(r.drops.size).toBe(0);
    expect(r.totals.size).toBe(1);
  });
});
