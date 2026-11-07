import { formatBatchId } from "../batchId.js";
import { anyCrash, CrashSignal, noCrashes, randomCrashes, type CrashInjector, type CrashPoint } from "../crash.js";
import { withInvariants } from "../invariants.js";
import { createMemoryStores } from "../stores/memory.js";
import type { Clock, Stores } from "../stores/types.js";
import type { BatchId } from "../types.js";
import { Worker, type StepOrder, type StepResult, type WorkerOptions, type WorkerSnapshot } from "../worker.js";
import { deriveSeed, mulberry32, type Prng } from "./prng.js";
import { EventQueue } from "./queue.js";
import { DEFAULT_WORKLOAD, generateWorkload, type Workload, type WorkloadConfig } from "./workload.js";

/**
 * Seeded discrete-event simulation (PLAN.md, "Scheduler"). The producer, the
 * workers and the Platform are actors on one sim clock; every worker step is one
 * event, so a crash can land between any two steps. The whole run is a pure
 * function of (seed, config, options).
 */

export interface SimConfig {
  readonly seed: number;
  readonly partitions: number;
  readonly maxBatch: number;
  /** Sim time one protocol step takes. */
  readonly stepMs: number;
  /** How long an idle worker waits before looking for new records. */
  readonly pollMs: number;
  readonly producerTickMs: number;
  /** Platform restart delay, uniform in [lo, hi]. */
  readonly restartDelayMs: readonly [number, number];
  readonly stepOrder: StepOrder;
  readonly workload: WorkloadConfig;
}

export const DEFAULT_SIM_CONFIG: Omit<SimConfig, "seed"> = {
  partitions: 8,
  maxBatch: 100,
  stepMs: 50,
  pollMs: 60_000,
  producerTickMs: 5_000,
  restartDelayMs: [5_000, 30_000],
  stepOrder: "dedupThenSink",
  workload: DEFAULT_WORKLOAD,
};

export type SimOverrides = Partial<Omit<SimConfig, "seed" | "workload">> & {
  readonly workload?: Partial<WorkloadConfig>;
};

export function simConfig(seed: number, overrides: SimOverrides = {}): SimConfig {
  return {
    ...DEFAULT_SIM_CONFIG,
    ...overrides,
    seed,
    workload: { ...DEFAULT_SIM_CONFIG.workload, ...overrides.workload },
  };
}

export interface SimOptions {
  /** Random crashes with this probability at each crash point (crash-test mode). */
  readonly crashProbability?: number;
  /** Scripted crashes, combined with random ones. */
  readonly crash?: CrashInjector;
  /** Check I1, I3, I4 on every store write. Default true. */
  readonly checkInvariants?: boolean;
  /** Record a line per event in `trace`. Default false. */
  readonly trace?: boolean;
  /** Extra worker options (e.g. safeguards), passed to every Worker the Platform starts. */
  readonly worker?: WorkerExtras;
  /** Called after every event. */
  readonly onEvent?: (e: SimEvent) => void;
}

/** Worker options the sim doesn't set itself (e.g. safeguards). */
export type WorkerExtras = Pick<WorkerOptions, "safeguards">;

export type SimEvent =
  | { readonly t: number; readonly type: "produce"; readonly appended: number }
  | {
      readonly t: number;
      readonly type: "step";
      readonly partition: number;
      readonly result: StepResult;
      readonly batchId: BatchId | null;
      readonly isReplay: boolean;
    }
  | {
      readonly t: number;
      readonly type: "crash";
      readonly partition: number;
      readonly point: CrashPoint;
      readonly batchId: BatchId;
      readonly isReplay: boolean;
      readonly restartAt: number;
    }
  | { readonly t: number; readonly type: "restart"; readonly partition: number };

export type LaneStatus = "running" | "restarting";

export interface LaneState {
  readonly partition: number;
  readonly status: LaneStatus;
  readonly restartAt: number | null;
  readonly epoch: number;
  readonly committedEnd: number;
  readonly plannedEnd: number;
  readonly logEnd: number;
  readonly worker: WorkerSnapshot | null;
}

export interface RunSummary {
  readonly drained: boolean;
  readonly events: number;
  readonly crashes: number;
  readonly simTimeMs: number;
}

type QueueItem = { kind: "produce" } | { kind: "step"; partition: number } | { kind: "restart"; partition: number };

interface Lane {
  worker: Worker | null;
  restartAt: number | null;
  idle: boolean;
}

export class Simulation {
  readonly config: SimConfig;
  readonly workload: Workload;
  /** Unwrapped stores, for reading. */
  readonly stores: Stores;
  readonly trace: string[] = [];
  readonly clock: Clock;
  now: number;
  crashes = 0;
  eventsProcessed = 0;

  private readonly writeStores: Stores;
  private readonly queue = new EventQueue<QueueItem>();
  private readonly lanes: Lane[];
  private readonly platformRng: Prng;
  private readonly workerRng: Prng;
  private readonly crash: CrashInjector;
  private readonly opts: SimOptions;
  private cursor = 0;

  constructor(config: SimConfig, opts: SimOptions = {}) {
    this.config = config;
    this.opts = opts;
    this.workload = generateWorkload(config.seed, config.workload);
    this.stores = createMemoryStores(config.partitions);
    this.writeStores = opts.checkInvariants === false ? this.stores : withInvariants(this.stores);
    this.platformRng = mulberry32(deriveSeed(config.seed, "platform"));
    this.workerRng = mulberry32(deriveSeed(config.seed, "worker"));
    const crashRng = mulberry32(deriveSeed(config.seed, "crash"));
    const injectors: CrashInjector[] = [];
    if (opts.crashProbability) injectors.push(randomCrashes(crashRng.next, opts.crashProbability));
    if (opts.crash) injectors.push(opts.crash);
    this.crash = injectors.length ? anyCrash(...injectors) : noCrashes;
    this.now = config.workload.startMs;
    this.clock = { now: () => this.now };

    this.queue.push(this.now, { kind: "produce" });
    this.lanes = Array.from({ length: config.partitions }, (_, p) => {
      this.queue.push(this.now, { kind: "step", partition: p });
      return { worker: this.makeWorker(p), restartAt: null, idle: false };
    });
  }

  get producerDone(): boolean {
    return this.cursor >= this.workload.events.length;
  }

  /** Producer finished and every partition is committed to its log end. */
  get drained(): boolean {
    if (!this.producerDone) return false;
    return this.lanes.every(
      (lane, p) => lane.worker !== null && lane.idle && this.committedEnd(p) === this.stores.source.endOffset(p),
    );
  }

  /** Process one event. Returns null once drained (or nothing is scheduled). */
  next(): SimEvent | null {
    if (this.drained) return null;
    const item = this.queue.pop();
    if (!item) return null;
    this.now = item.t;
    this.eventsProcessed++;
    const ev = this.handle(item.value);
    if (this.opts.trace) this.trace.push(formatSimEvent(ev));
    this.opts.onEvent?.(ev);
    return ev;
  }

  run(maxEvents = 10_000_000): RunSummary {
    for (let i = 0; i < maxEvents; i++) if (this.next() === null) break;
    return {
      drained: this.drained,
      events: this.eventsProcessed,
      crashes: this.crashes,
      simTimeMs: this.now - this.config.workload.startMs,
    };
  }

  lane(p: number): LaneState {
    const lane = this.lanes[p]!;
    const log = this.stores.batchLogs[p]!;
    return {
      partition: p,
      status: lane.worker ? "running" : "restarting",
      restartAt: lane.restartAt,
      epoch: log.epoch,
      committedEnd: this.committedEnd(p),
      plannedEnd: log.lastPlan()?.endOffset ?? -1,
      logEnd: this.stores.source.endOffset(p),
      worker: lane.worker?.snapshot() ?? null,
    };
  }

  laneStates(): LaneState[] {
    return this.lanes.map((_, p) => this.lane(p));
  }

  private committedEnd(p: number): number {
    return this.stores.batchLogs[p]!.lastCommit()?.endOffset ?? -1;
  }

  private makeWorker(p: number): Worker {
    return new Worker({
      ...this.opts.worker,
      partition: p,
      stores: this.writeStores,
      maxBatch: this.config.maxBatch,
      crash: this.crash,
      stepOrder: this.config.stepOrder,
      clock: this.clock,
      random: this.workerRng.next,
    });
  }

  private handle(item: QueueItem): SimEvent {
    const t = this.now;
    switch (item.kind) {
      case "produce": {
        const events = this.workload.events;
        const start = this.cursor;
        while (this.cursor < events.length && events[this.cursor]!.appendedAt <= t) {
          this.writeStores.source.append(events[this.cursor++]!);
        }
        if (!this.producerDone) this.queue.push(t + this.config.producerTickMs, { kind: "produce" });
        return { t, type: "produce", appended: this.cursor - start };
      }
      case "restart": {
        // Platform: start a fresh Worker. Its first step bumps the epoch and recovers.
        const lane = this.lanes[item.partition]!;
        lane.worker = this.makeWorker(item.partition);
        lane.restartAt = null;
        lane.idle = false;
        this.queue.push(t + this.config.stepMs, { kind: "step", partition: item.partition });
        return { t, type: "restart", partition: item.partition };
      }
      case "step": {
        const p = item.partition;
        const lane = this.lanes[p]!;
        const worker = lane.worker!;
        try {
          const result = worker.step();
          const snap = worker.snapshot();
          lane.idle = result.kind === "idle";
          this.queue.push(t + (lane.idle ? this.config.pollMs : this.config.stepMs), { kind: "step", partition: p });
          return { t, type: "step", partition: p, result, batchId: snap.plan?.id ?? null, isReplay: snap.isReplay };
        } catch (e) {
          if (!(e instanceof CrashSignal)) throw e;
          // The Worker object (all its memory) is discarded. Platform restarts after a seeded delay.
          this.crashes++;
          const [lo, hi] = this.config.restartDelayMs;
          const restartAt = t + this.platformRng.int(lo, hi);
          lane.worker = null;
          lane.idle = false;
          lane.restartAt = restartAt;
          this.queue.push(restartAt, { kind: "restart", partition: p });
          return { t, type: "crash", partition: p, point: e.point, batchId: e.ctx.batchId, isReplay: e.ctx.isReplay, restartAt };
        }
      }
    }
  }
}

export function formatSimEvent(e: SimEvent): string {
  switch (e.type) {
    case "produce":
      return `${e.t} produce +${e.appended}`;
    case "restart":
      return `${e.t} P${e.partition} restart`;
    case "crash":
      return `${e.t} P${e.partition} CRASH ${e.point} ${formatBatchId(e.batchId)}${e.isReplay ? " replay" : ""} restartAt=${e.restartAt}`;
    case "step": {
      const id = e.batchId ? formatBatchId(e.batchId) : "-";
      const { kind, ...rest } = e.result;
      if ("decisions" in rest) delete (rest as { decisions?: unknown }).decisions;
      return `${e.t} P${e.partition} ${kind} ${id}${e.isReplay ? " replay" : ""} ${JSON.stringify(rest)}`;
    }
  }
}
