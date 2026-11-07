import { parentPort, workerData } from "node:worker_threads";
import type { ToggleName } from "@eob/engine";
import { runCrashTestSeed, type CrashTestParams } from "./crashTest.js";

interface Job {
  readonly seeds: readonly number[];
  readonly toggles: readonly ToggleName[];
  readonly params: CrashTestParams;
}

const job = workerData as Job;
parentPort!.postMessage(job.seeds.map((seed) => runCrashTestSeed(seed, job.toggles, job.params)));
