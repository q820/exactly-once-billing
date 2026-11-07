import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import {
  aggregate,
  explainFailure,
  formatUsd,
  renderMarkdown,
  CRASH_TEST_CONFIGS,
  verdict,
  type ConfigReport,
  type SeedSummary,
  type CrashTestConfig,
  type CrashTestParams,
} from "./crashTest.js";

/** pnpm crash-test -- --seeds 2000 --p 0.05 */

const { values } = parseArgs({
  // `pnpm crash-test -- --seeds 10` passes the "--" through; drop it.
  args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === "--")),
  options: {
    seeds: { type: "string", default: "2000" },
    p: { type: "string", default: "0.05" },
    threads: { type: "string", default: String(Math.max(1, availableParallelism() - 1)) },
    only: { type: "string" },
    skip: { type: "string" },
    out: { type: "string", default: "results/crash-test.md" },
    json: { type: "string", default: "results/crash-test.json" },
    messages: { type: "string" },
  },
  allowPositionals: true,
});

const seeds = Number(values.seeds);
const params: CrashTestParams = {
  p: Number(values.p),
  ...(values.messages ? { overrides: { workload: { messages: Number(values.messages) } } } : {}),
};
const threads = Math.max(1, Number(values.threads));
const skip = new Set(values.skip?.split(",") ?? []);
const configs = (
  values.only
    ? CRASH_TEST_CONFIGS.filter((c) => values.only!.split(",").includes(c.name) || (values.only === "on" && !c.toggles.length))
    : CRASH_TEST_CONFIGS
).filter((c) => !skip.has(c.name));
if (skip.size) console.log(`skipping: ${[...skip].join(", ")}`);
if (!configs.length) throw new Error(`no config matches --only ${values.only}`);

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "../../..");

function runChunk(seedList: number[], config: CrashTestConfig): Promise<SeedSummary[]> {
  return new Promise((ok, fail) => {
    const w = new Worker(new URL("./thread.ts", import.meta.url), {
      workerData: { seeds: seedList, toggles: config.toggles, params },
    });
    w.once("message", ok);
    w.once("error", fail);
  });
}

async function runConfig(config: CrashTestConfig): Promise<ConfigReport> {
  const t0 = performance.now();
  const all = Array.from({ length: seeds }, (_, i) => i + 1);
  const n = Math.min(threads, seeds);
  const chunks = Array.from({ length: n }, (_, k) => all.filter((_, i) => i % n === k));
  const summaries = (await Promise.all(chunks.map((c) => runChunk(c, config)))).flat().sort((a, b) => a.seed - b.seed);
  const firstBad = summaries.find((s) => !s.ok);
  const first = firstBad ? explainFailure(firstBad.seed, config.toggles, params) : null;
  return aggregate(config, summaries, performance.now() - t0, first);
}

const reports: ConfigReport[] = [];
console.log(`crash-test: ${seeds} seeds x ${configs.length} configs, p=${params.p}, ${threads} threads\n`);
for (const config of configs) {
  const r = await runConfig(config);
  reports.push(r);
  const rate = (r.seeds / (r.ms / 1000)).toFixed(0);
  console.log(
    `${verdict(r).padEnd(4)} ${r.name.padEnd(24)} failed ${String(r.failed).padStart(5)}/${r.seeds}` +
      `  over ${formatUsd(r.overMicros).padStart(12)}  under ${formatUsd(r.underMicros).padStart(12)}` +
      `  violations ${String(r.violations).padStart(4)}  crashes ${r.crashes.toLocaleString("en-US").padStart(9)}  ${rate} seeds/s`,
  );
  if (r.firstFailure) console.log(`     first failing seed ${r.firstFailure.seed}: ${r.firstFailure.reason}`);
}

const command = `pnpm crash-test -- --seeds ${seeds} --p ${params.p}${values.messages ? ` --messages ${values.messages}` : ""}`;
for (const [file, body] of [
  [values.out!, renderMarkdown(reports, { p: params.p, command })],
  [values.json!, JSON.stringify({ seeds, p: params.p, reports }, null, 2)],
] as const) {
  const path = resolve(repoRoot, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body + "\n");
}
console.log(`\nwrote ${values.out} and ${values.json}`);

const failed = reports.filter((r) => verdict(r) === "FAIL");
if (failed.length) {
  console.error(`\nFAIL: ${failed.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
