/// <reference lib="webworker" />
import type { ToggleName } from "@eob/engine";
import { runCrashTestSeed, type CrashTestParams } from "@eob/crash-test";

export interface CrashTestJob {
  readonly job: number;
  readonly config: number;
  readonly toggles: readonly ToggleName[];
  readonly seeds: readonly number[];
  readonly params: CrashTestParams;
}

self.onmessage = (e: MessageEvent<CrashTestJob>) => {
  const { job, config, toggles, seeds, params } = e.data;
  const summaries = seeds.map((seed) => runCrashTestSeed(seed, toggles, params));
  self.postMessage({ job, config, summaries });
};
