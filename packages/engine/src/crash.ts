import { formatBatchId } from "./batchId.js";
import type { BatchId } from "./types.js";

/**
 * Named crash points (PLAN.md, "Batch protocol").
 * C1 after plan, C2 after dedup writes, C3 after sink writes, C4 after commit.
 * C2a / C3a fire halfway through the dedup / sink writes.
 */
export const CRASH_POINTS = ["C1", "C2a", "C2", "C3a", "C3", "C4"] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export interface CrashContext {
  readonly partition: number;
  readonly batchId: BatchId;
  readonly isReplay: boolean;
}

/** Thrown at an armed crash point. Everything written before it stays durable. */
export class CrashSignal extends Error {
  readonly point: CrashPoint;
  readonly ctx: CrashContext;

  constructor(point: CrashPoint, ctx: CrashContext) {
    super(`P${ctx.partition} crashed at ${point} during batch ${formatBatchId(ctx.batchId)}`);
    this.name = "CrashSignal";
    this.point = point;
    this.ctx = ctx;
  }
}

/** Consulted at every crash point. Lives outside the worker, so it survives restarts. */
export interface CrashInjector {
  shouldCrash(point: CrashPoint, ctx: CrashContext): boolean;
}

export const noCrashes: CrashInjector = { shouldCrash: () => false };

/** Torture mode: crash with probability p at every crash point the worker reaches. */
export function randomCrashes(next: () => number, p: number): CrashInjector {
  return { shouldCrash: () => next() < p };
}

/** Crash if any injector says so. Every injector is consulted, so each one's PRNG stream advances the same way. */
export function anyCrash(...injectors: CrashInjector[]): CrashInjector {
  return {
    shouldCrash(point, ctx) {
      let crash = false;
      for (const i of injectors) if (i.shouldCrash(point, ctx)) crash = true;
      return crash;
    },
  };
}

export interface ScriptedCrash {
  readonly partition: number;
  /** Matches batchId.idx, which is stable across a replay. */
  readonly batchIdx: number;
  readonly point: CrashPoint;
  /** Only fire on a first attempt (false) or only on a replay (true). Default: either. */
  readonly isReplay?: boolean;
  /** How many times to fire. Default 1. */
  readonly times?: number;
}

/** A crash armed for specific (partition, batch, point) targets, e.g. "P3, batch 2, at C2". */
export function scriptedCrash(...targets: ScriptedCrash[]): CrashInjector {
  const remaining = targets.map((t) => t.times ?? 1);
  return {
    shouldCrash(point, ctx) {
      for (const [i, t] of targets.entries()) {
        if (
          remaining[i]! > 0 &&
          t.point === point &&
          t.partition === ctx.partition &&
          t.batchIdx === ctx.batchId.idx &&
          (t.isReplay === undefined || t.isReplay === ctx.isReplay)
        ) {
          remaining[i]!--;
          return true;
        }
      }
      return false;
    },
  };
}
