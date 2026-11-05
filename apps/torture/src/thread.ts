import { parentPort, workerData } from "node:worker_threads";
import type { ToggleName } from "@eob/engine";
import { runTortureSeed, type TortureParams } from "./torture.js";

interface Job {
  readonly seeds: readonly number[];
  readonly toggles: readonly ToggleName[];
  readonly params: TortureParams;
}

const job = workerData as Job;
parentPort!.postMessage(job.seeds.map((seed) => runTortureSeed(seed, job.toggles, job.params)));
