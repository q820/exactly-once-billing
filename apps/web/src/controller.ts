import {
  diffTotals,
  formatBatchId,
  ledgerTotals,
  simConfig,
  Simulation,
  type BatchId,
  type CrashInjector,
  type CrashPoint,
  type ScriptedCrash,
  type SimEvent,
  type TotalsDiff,
} from "@eob/engine";
import { computeExpected, eventKey, type OracleResult } from "@eob/oracle";
import { engineDropKeys } from "@eob/crash-test";
import { simOptions } from "./outcome.js";
import type { RunSpec } from "./scenarios.js";

export type Decision = "kept" | "duplicate" | "dropped";

export interface DecisionRecord {
  readonly t: number;
  readonly batchId: BatchId;
  readonly isReplay: boolean;
  readonly decision: Decision;
}

/** "Clicking ⚡ arms a crash for the next time the worker reaches that point." */
class ArmedCrashes implements CrashInjector {
  armed: { partition: number; point: CrashPoint }[] = [];
  readonly fired: ScriptedCrash[] = [];

  shouldCrash(point: CrashPoint, ctx: { partition: number; batchId: BatchId; isReplay: boolean }): boolean {
    const i = this.armed.findIndex((a) => a.partition === ctx.partition && a.point === point);
    if (i < 0) return false;
    this.armed.splice(i, 1);
    // Recorded as a scripted crash so a replay with other toggles crashes at the same place.
    this.fired.push({ partition: ctx.partition, batchIdx: ctx.batchId.idx, point, isReplay: ctx.isReplay });
    return true;
  }
}

export interface Status {
  readonly kind: "running" | "green" | "red";
  readonly label: string;
  readonly diff: TotalsDiff;
  readonly drained: boolean;
  readonly dropsMatch: boolean;
  readonly committedPct: number;
}

const MAX_NARRATION = 400;

export class Controller {
  readonly spec: RunSpec;
  readonly sim: Simulation;
  readonly oracle: OracleResult;
  readonly narration: { t: number; text: string; tone?: "bad" | "good" }[] = [];
  /** `${partition}:${offset}` -> every filter decision ever made about that record. */
  readonly decisions = new Map<string, DecisionRecord[]>();
  private readonly armedCrashes = new ArmedCrashes();
  private drainedNoted = false;

  constructor(spec: RunSpec) {
    this.spec = spec;
    const opts = simOptions(spec, this.armedCrashes);
    this.sim = new Simulation(simConfig(spec.seed, spec.overrides), { ...opts, onEvent: (e) => this.observe(e) });
    this.oracle = computeExpected(this.sim.workload.events);
  }

  get armed(): readonly { partition: number; point: CrashPoint }[] {
    return this.armedCrashes.armed;
  }

  /** Crashes that actually fired, scripted or armed, for an exact replay. */
  replayCrashes(): ScriptedCrash[] {
    return [...this.spec.crashes, ...this.armedCrashes.fired];
  }

  arm(partition: number, point: CrashPoint): void {
    const a = this.armedCrashes.armed;
    const i = a.findIndex((x) => x.partition === partition && x.point === point);
    if (i >= 0) a.splice(i, 1);
    else a.push({ partition, point });
  }

  /** Process up to n events. Returns false once drained. */
  advance(n: number): boolean {
    for (let i = 0; i < n; i++) {
      if (this.sim.next() === null) {
        this.noteDrained();
        return false;
      }
    }
    return true;
  }

  runUntil(t: number): void {
    while (this.sim.now < t && this.sim.next() !== null);
    if (this.sim.drained) this.noteDrained();
  }

  runToEnd(): void {
    this.sim.run();
    this.noteDrained();
  }

  status(): Status {
    const diff = diffTotals(ledgerTotals(this.sim.stores.ledger), this.oracle.totals);
    const drained = this.sim.drained;
    const dropKeys = engineDropKeys(this.sim.stores);
    const dropsMatch = dropKeys.size === this.oracle.drops.size && [...dropKeys].every((k) => this.oracle.drops.has(k));
    const lanes = this.sim.laneStates();
    const total = this.sim.workload.events.length;
    const committed = lanes.reduce((s, l) => s + l.committedEnd + 1, 0);
    const committedPct = total ? Math.round((100 * committed) / total) : 100;
    // Rows only grow, so engine > oracle is a real error even mid-run; engine < oracle is only final once drained.
    if (diff.overMicros > 0 || (drained && diff.underMicros > 0)) {
      const parts = [];
      if (diff.overMicros > 0) parts.push(`Over-billed ${usdShort(diff.overMicros)}`);
      if (drained && diff.underMicros > 0) parts.push(`Under-billed ${usdShort(diff.underMicros)}`);
      return { kind: "red", label: parts.join(" · "), diff, drained, dropsMatch, committedPct };
    }
    if (drained && !dropsMatch) return { kind: "red", label: "DropLog ≠ oracle drops", diff, drained, dropsMatch, committedPct };
    if (drained) return { kind: "green", label: "Ledger matches oracle", diff, drained, dropsMatch, committedPct };
    return { kind: "running", label: `Running · ${committedPct}% committed`, diff, drained, dropsMatch, committedPct };
  }

  /** Messages the oracle bills but whose every copy was last judged a duplicate or never kept. */
  lostMessages(): string[] {
    const billedFirstCopy = new Map<string, string>();
    for (const e of this.sim.workload.events) {
      if (this.oracle.drops.has(eventKey(e)) || billedFirstCopy.has(e.messageId)) continue;
      billedFirstCopy.set(e.messageId, e.messageId);
    }
    const lastKept = new Set<string>();
    for (let p = 0; p < this.sim.config.partitions; p++) {
      for (const rec of this.sim.stores.source.read(p, 0, this.sim.stores.source.endOffset(p))) {
        const d = this.decisions.get(`${p}:${rec.offset}`);
        if (d?.at(-1)?.decision === "kept") lastKept.add(rec.messageId);
      }
    }
    return [...billedFirstCopy.keys()].filter((m) => !lastKept.has(m));
  }

  private say(t: number, text: string, tone?: "bad" | "good") {
    this.narration.push(tone ? { t, text, tone } : { t, text });
    if (this.narration.length > MAX_NARRATION) this.narration.splice(0, this.narration.length - MAX_NARRATION);
  }

  private noteDrained() {
    if (this.drainedNoted || !this.sim.drained) return;
    this.drainedNoted = true;
    const s = this.status();
    this.say(this.sim.now, `All partitions drained. ${s.label}.`, s.kind === "green" ? "good" : "bad");
  }

  private observe(e: SimEvent) {
    if (e.type === "crash") {
      const secs = Math.round((e.restartAt - e.t) / 1000);
      this.say(
        e.t,
        `P${e.partition} crashed at ${e.point} during ${e.isReplay ? "the replay of " : ""}batch ${formatBatchId(e.batchId)}. Platform restarts it in ${secs}s.`,
        "bad",
      );
      return;
    }
    if (e.type !== "step") return;
    const r = e.result;
    const p = e.partition;
    switch (r.kind) {
      case "recovered":
        if (r.epoch === 1) return;
        if (r.replay) {
          this.say(
            e.t,
            `P${p} restarted as epoch ${r.epoch}. Replaying ${formatBatchId(r.replay.id)} from offsets ${r.replay.startOffset}–${r.replay.endOffset}.`,
          );
        } else this.say(e.t, `P${p} restarted as epoch ${r.epoch}. Nothing uncommitted; planning the next batch.`);
        return;
      case "filtered": {
        const id = e.batchId!;
        const note = (decision: Decision) => (rec: { partition: number; offset: number }) => {
          const k = `${rec.partition}:${rec.offset}`;
          const list = this.decisions.get(k) ?? [];
          list.push({ t: e.t, batchId: id, isReplay: e.isReplay, decision });
          this.decisions.set(k, list);
        };
        r.decisions.kept.forEach(note("kept"));
        r.decisions.duplicates.forEach(note("duplicate"));
        r.decisions.dropped.forEach(note("dropped"));
        for (const d of r.decisions.dropped) {
          this.say(e.t, `P${p} sent ${d.messageId} to the DropLog: sent ${Math.floor((d.appendedAt - d.sentAt) / 86_400_000)} days before it was appended.`);
        }
        if (e.isReplay) this.say(e.t, `P${p} replay ${formatBatchId(id)} filter: kept ${r.kept}, duplicates ${r.duplicates}.`);
        return;
      }
      case "sinkWritten":
        if (e.isReplay) {
          this.say(
            e.t,
            `P${p} replay ${formatBatchId(e.batchId!)} sink: ${r.applied} applied, ${r.rejected} rejected by CAS (already applied).`,
          );
        }
        return;
      case "committed":
        if (e.isReplay) this.say(e.t, `P${p} committed the replay of ${formatBatchId(r.commit.id)} through offset ${r.commit.endOffset}.`);
        return;
    }
  }
}

function usdShort(micros: number): string {
  return `$${(micros / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}
