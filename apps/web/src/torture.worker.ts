/// <reference lib="webworker" />
import type { ToggleName } from "@eob/engine";
import { runTortureSeed, type TortureParams } from "@eob/torture";

export interface TortureJob {
  readonly job: number;
  readonly config: number;
  readonly toggles: readonly ToggleName[];
  readonly seeds: readonly number[];
  readonly params: TortureParams;
}

self.onmessage = (e: MessageEvent<TortureJob>) => {
  const { job, config, toggles, seeds, params } = e.data;
  const summaries = seeds.map((seed) => runTortureSeed(seed, toggles, params));
  self.postMessage({ job, config, summaries });
};
