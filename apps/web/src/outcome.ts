import { anyCrash, scriptedCrash, type CrashInjector } from "@eob/engine";
import { runSeed, type SeedResult } from "@eob/crash-test";
import type { Outcome, RunSpec } from "./scenarios.js";

export function simOptions(spec: RunSpec, extra?: CrashInjector) {
  const scripted = scriptedCrash(...spec.crashes);
  return {
    crashProbability: spec.crashProbability,
    crash: extra ? anyCrash(scripted, extra) : scripted,
    worker: { safeguards: spec.safeguards },
  };
}

export function outcomeOf(r: Pick<SeedResult, "ok" | "diff" | "dropsMatch">): Outcome {
  if (r.ok) return "green";
  const { overMicros: o, underMicros: u } = r.diff;
  if (o > 0 && u === 0) return "over";
  if (u > 0 && o === 0) return "under";
  return "mixed";
}

/** Run a spec headlessly to the end. Used by tests and to verify scenarios. */
export function runSpec(spec: RunSpec): SeedResult {
  return runSeed(spec.seed, spec.overrides, simOptions(spec));
}
