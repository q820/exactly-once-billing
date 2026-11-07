import { describe, expect, it } from "vitest";
import { DAY_MS, RETENTION_MS } from "../time.js";
import type { DeliveryEvent, SinkKey } from "../types.js";
import { createMemoryStores } from "./memory.js";

const key: SinkKey = { account: "A", sku: "marketing", halfHour: 10, partition: 0 };
const id = (epoch: number, idx: number) => ({ epoch, idx });
const event = (messageId: string): DeliveryEvent => ({
  messageId,
  deviceId: "d1",
  account: "A",
  sku: "utility",
  priceMicros: 8_000,
  sentAt: 0,
  deliveredAt: 1,
  appendedAt: 2,
});

describe("SourceLog", () => {
  it("assigns offsets per partition and reads ranges deterministically", () => {
    const { source } = createMemoryStores(4);
    for (let i = 0; i < 40; i++) source.append(event(`m${i}`));
    const total = [0, 1, 2, 3].reduce((n, p) => n + source.endOffset(p) + 1, 0);
    expect(total).toBe(40);
    const p = [0, 1, 2, 3].find((q) => source.endOffset(q) >= 3)!;
    const first = source.read(p, 1, 3);
    expect(first.map((r) => r.offset)).toEqual([1, 2, 3]);
    expect(source.read(p, 1, 3)).toEqual(first);
    expect(first.every((r) => r.partition === p)).toBe(true);
  });

  it("routes every copy of a messageId to the same partition", () => {
    const { source } = createMemoryStores(8);
    const a = source.append(event("same"));
    const b = source.append({ ...event("same"), deviceId: "d2" });
    expect(b.partition).toBe(a.partition);
  });

  it("reports -1 for an empty partition and clamps reads to the log end", () => {
    const { source } = createMemoryStores(1);
    expect(source.endOffset(0)).toBe(-1);
    source.append(event("m1"));
    expect(source.read(0, 0, 10)).toHaveLength(1);
  });
});

describe("BatchLog", () => {
  it("bumps the epoch and remembers the last plan and commit", () => {
    const log = createMemoryStores(1).batchLogs[0]!;
    expect(log.epoch).toBe(0);
    expect(log.bumpEpoch()).toBe(1);
    expect(log.lastPlan()).toBeNull();
    expect(log.lastCommit()).toBeNull();
    log.writePlan({ id: id(1, 1), startOffset: 0, endOffset: 3 });
    log.commit(id(1, 1), 3);
    expect(log.lastPlan()?.endOffset).toBe(3);
    expect(log.lastCommit()).toEqual({ id: id(1, 1), endOffset: 3 });
  });
});

describe("DedupStore", () => {
  it("putIfAbsent never overwrites", () => {
    const dedup = createMemoryStores(1).dedup[0]!;
    expect(dedup.putIfAbsent("m1", { id: id(1, 1), seenAt: 0 })).toBe(true);
    expect(dedup.putIfAbsent("m1", { id: id(2, 5), seenAt: 9 })).toBe(false);
    expect(dedup.get("m1")?.id).toEqual(id(1, 1));
  });

  it("expire removes entries older than the 30-day TTL", () => {
    const dedup = createMemoryStores(1).dedup[0]!;
    dedup.putIfAbsent("old", { id: id(1, 1), seenAt: 0 });
    dedup.putIfAbsent("new", { id: id(1, 1), seenAt: 10 * DAY_MS });
    expect(dedup.expire(RETENTION_MS)).toBe(0); // exactly at the edge: kept
    expect(dedup.expire(RETENTION_MS + 1)).toBe(1);
    expect(dedup.get("old")).toBeUndefined();
    expect(dedup.get("new")).toBeDefined();
  });
});

describe("Ledger.casApply", () => {
  it("applies only when id > lastApplied", () => {
    const { ledger } = createMemoryStores(1);
    expect(ledger.casApply(key, 100, id(1, 1))).toBe("applied");
    expect(ledger.casApply(key, 100, id(1, 1))).toBe("rejected"); // same batch again
    expect(ledger.casApply(key, 100, id(1, 0))).toBe("rejected"); // older
    expect(ledger.casApply(key, 50, id(2, 2))).toBe("applied");
    expect(ledger.rows()).toEqual([{ key, totalMicros: 150, lastApplied: id(2, 2) }]);
  });

  it("orders BatchIds by epoch first", () => {
    const { ledger } = createMemoryStores(1);
    ledger.casApply(key, 1, id(1, 2));
    expect(ledger.casApply(key, 1, id(2, 2))).toBe("applied"); // a re-stamped replay looks newer
  });

  it("rejects non-integer money", () => {
    const { ledger } = createMemoryStores(1);
    expect(() => ledger.casApply(key, 0.5, id(1, 1))).toThrow();
  });
});

describe("DropLog", () => {
  it("is idempotent per (partition, offset)", () => {
    const { drops } = createMemoryStores(1);
    const d = { partition: 0, offset: 7, messageId: "m6", batchId: id(1, 2), reason: "pastRetention" as const };
    expect(drops.record(d)).toBe(true);
    expect(drops.record({ ...d, batchId: id(1, 2) })).toBe(false);
    expect(drops.all()).toHaveLength(1);
  });
});
