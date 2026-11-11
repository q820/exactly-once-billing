import { describe, expect, it } from "vitest";
import { scriptedCrash, type CrashPoint } from "./crash.js";
import { breakIt, TOGGLES, type ToggleName } from "./safeguards.js";
import { EXPECTED_DROP_OFFSETS, EXPECTED_TOTALS, MARKETING, UTILITY } from "./test/fixture.js";
import { drain, fixtureStores, totals } from "./test/harness.js";
import type { StepOrder } from "./worker.js";
import type { DeliveryEvent } from "./types.js";

/**
 * One targeted test per break-it toggle, on the hand-written fixture: the
 * crash point PLAN.md says exposes it must produce the predicted billing error,
 * and a crash point that doesn't expose it must still bill correctly. Proves
 * each toggle fails for the reason it claims, not by accident.
 */

const EXPECTED_SUM = Object.values(EXPECTED_TOTALS).reduce((a, b) => a + b, 0);

function run(
  toggle: ToggleName,
  point: CrashPoint | null,
  extra: { random?: () => number; stepOrder?: StepOrder } = {},
) {
  const stores = fixtureStores();
  drain(stores, {
    safeguards: breakIt(toggle),
    ...(point ? { crash: scriptedCrash({ partition: 0, batchIdx: 2, point }) } : {}),
    ...extra,
  });
  const t = totals(stores.ledger);
  return {
    net: Object.values(t).reduce((a, b) => a + b, 0) - EXPECTED_SUM,
    matches: JSON.stringify(Object.entries(t).sort()) === JSON.stringify(Object.entries(EXPECTED_TOTALS).sort()),
    drops: stores.drops.all().map((d) => d.offset),
  };
}

// Batch 2 keeps m4 (utility) and m5 (marketing, late); their later copies sit in batch 3.
const BATCH2 = UTILITY + MARKETING;

describe("atMostOnce: commit before the sink writes", () => {
  it("crash at C3a: batch 2 is already committed, so recovery skips it and the rows not yet written are lost", () => {
    const r = run("atMostOnce", "C3a");
    expect(r.net).toBe(-UTILITY); // m5's row was written, m4's wasn't
    expect(r.drops).toEqual([7]);
  });

  it("crash at C3a with the sink first: the dedup entries are never written either", () => {
    const r = run("atMostOnce", "C3a", { stepOrder: "sinkThenDedup" });
    expect(r.matches).toBe(false);
  });

  for (const point of ["C1", "C2a", "C2"] as const) {
    it(`crash at ${point} (before the early commit): the batch replays -> still correct`, () => {
      expect(run("atMostOnce", point).matches).toBe(true);
    });
  }

  it("crash at C3 (every sink row already written): still correct", () => {
    expect(run("atMostOnce", "C3").matches).toBe(true);
  });

  it("crash at C4 (after the real commit): still correct", () => {
    expect(run("atMostOnce", "C4").matches).toBe(true);
  });
});

describe("dedupIgnoresBatchId: any existing key is a duplicate", () => {
  it("crash at C2: the replay dedupes its own earlier attempt -> under-billed", () => {
    expect(run("dedupIgnoresBatchId", "C2").net).toBe(-BATCH2);
  });

  it("crash at C2a: only the half written before the crash is lost", () => {
    expect(run("dedupIgnoresBatchId", "C2a").net).toBe(-UTILITY); // m4's entry was written first
  });

  it("crash at C3 (sink already applied): still correct", () => {
    expect(run("dedupIgnoresBatchId", "C3").matches).toBe(true);
  });
});

describe("nondeterministicBatches: the replay reads whatever is available up to a random size", () => {
  it("crash at C2 and a shrunken replay: the next batch falsely dedupes the rest -> under-billed", () => {
    // Replay size 1 reads only offset 4 (m4). m5 at offset 6 has the first attempt's entry, so batch 3 skips it.
    expect(run("nondeterministicBatches", "C2", { random: () => 0 }).net).toBe(-MARKETING);
  });

  it("crash at C2 but the replay happens to read the same range: correct", () => {
    expect(run("nondeterministicBatches", "C2", { random: () => 0.99 }).matches).toBe(true);
  });
});

describe("atLeastOnce: no CAS on the sink", () => {
  it("crash at C3: the replay adds both rows again -> over-billed", () => {
    expect(run("atLeastOnce", "C3").net).toBe(BATCH2);
  });

  it("crash at C3a: the row written before the crash is added twice", () => {
    expect(run("atLeastOnce", "C3a").net).toBe(MARKETING); // m5's late row sorts first
  });

  it("crash at C2 (nothing in the sink yet): still correct", () => {
    expect(run("atLeastOnce", "C2").matches).toBe(true);
  });
});

describe("retention is decided from record fields only", () => {
  const DAY = 86_400_000;
  const T = 1_000 * DAY;
  const at = (messageId: string, sentAt: number): DeliveryEvent => ({
    messageId,
    deviceId: "d1",
    account: "A",
    sku: "marketing",
    priceMicros: MARKETING,
    sentAt,
    deliveredAt: sentAt + DAY,
    appendedAt: T,
  });

  it("bills a copy exactly at the 30-day edge and drops one 1 ms past it", () => {
    const stores = fixtureStores([at("edge", T - 30 * DAY), at("past", T - 30 * DAY - 1)]);
    drain(stores);
    expect(Object.values(totals(stores.ledger))).toEqual([MARKETING]);
    expect(stores.drops.all().map((d) => d.messageId)).toEqual(["past"]);
  });
});

describe("every toggle off one at a time leaves the others on", () => {
  it.each(TOGGLES.map((t) => t.name))("%s", (name) => {
    const s = breakIt(name);
    expect(Object.values(s).filter((v) => !v)).toHaveLength(1);
  });

  it("all on with every crash point is correct (control)", () => {
    for (const point of ["C1", "C2a", "C2", "C3a", "C3", "C4"] as const) {
      const stores = fixtureStores();
      drain(stores, { crash: scriptedCrash({ partition: 0, batchIdx: 2, point }) });
      expect(totals(stores.ledger)).toEqual(EXPECTED_TOTALS);
      expect(stores.drops.all().map((d) => d.offset)).toEqual(EXPECTED_DROP_OFFSETS);
    }
  });
});
