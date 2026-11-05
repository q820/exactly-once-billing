import { breakIt, formatSimEvent, TOGGLES, type SimOverrides, type ToggleName } from "@eob/engine";
import { runSeed, type SeedResult } from "./verify.js";

/**
 * Torture runs (PLAN.md, "Torture test"). Browser-safe: the Node CLI and the
 * web app's Web Worker both use this.
 */

export interface TortureConfig {
  readonly name: string;
  readonly toggles: readonly ToggleName[];
}

export const TORTURE_CONFIGS: readonly TortureConfig[] = [
  { name: "all safeguards on", toggles: [] },
  ...TOGGLES.map((t) => ({ name: t.name, toggles: [t.name] })),
];

export interface SeedSummary {
  readonly seed: number;
  readonly ok: boolean;
  readonly crashes: number;
  readonly overMicros: number;
  readonly underMicros: number;
  readonly dropsMatch: boolean;
  readonly drained: boolean;
  readonly violation: string | null;
}

export interface TortureParams {
  readonly p: number;
  readonly overrides?: SimOverrides;
}

export function runTortureSeed(seed: number, toggles: readonly ToggleName[], params: TortureParams): SeedSummary {
  return summarize(
    runSeed(seed, params.overrides ?? {}, {
      crashProbability: params.p,
      worker: { safeguards: breakIt(...toggles) },
    }),
  );
}

export function summarize(r: SeedResult): SeedSummary {
  return {
    seed: r.seed,
    ok: r.ok,
    crashes: r.crashes,
    overMicros: r.diff.overMicros,
    underMicros: r.diff.underMicros,
    dropsMatch: r.dropsMatch,
    drained: r.drained,
    violation: r.violation,
  };
}

export interface FirstFailure {
  readonly seed: number;
  readonly reason: string;
  readonly crashCount: number;
  /** The crash events of the failing run, in order (first few). */
  readonly crashTrace: readonly string[];
  readonly mismatchedRows: number;
}

export interface ConfigReport {
  readonly name: string;
  readonly toggles: readonly ToggleName[];
  readonly seeds: number;
  readonly failed: number;
  readonly crashes: number;
  readonly overMicros: number;
  readonly underMicros: number;
  readonly violations: number;
  readonly dropMismatches: number;
  readonly firstFailure: FirstFailure | null;
  readonly ms: number;
}

export function failureReason(s: SeedSummary): string {
  const parts: string[] = [];
  if (s.violation) parts.push(s.violation);
  if (s.overMicros) parts.push(`over-billed ${formatUsd(s.overMicros)}`);
  if (s.underMicros) parts.push(`under-billed ${formatUsd(s.underMicros)}`);
  if (!s.dropsMatch) parts.push("DropLog != oracle drops");
  if (!s.drained) parts.push("did not drain");
  return parts.join("; ") || "ok";
}

/** Re-run one seed with tracing on to recover its crash trace. Deterministic, so this is the same run. */
export function explainFailure(
  seed: number,
  toggles: readonly ToggleName[],
  params: TortureParams,
  maxLines = 12,
): FirstFailure {
  const r = runSeed(
    seed,
    params.overrides ?? {},
    { crashProbability: params.p, worker: { safeguards: breakIt(...toggles) }, trace: true },
    Number.MAX_SAFE_INTEGER,
  );
  const crashes = r.trace.filter((l) => l.includes(" CRASH "));
  return {
    seed,
    reason: failureReason(summarize(r)),
    crashCount: crashes.length,
    crashTrace: crashes.slice(0, maxLines),
    mismatchedRows: r.diff.mismatched.length,
  };
}

export function aggregate(
  config: TortureConfig,
  summaries: readonly SeedSummary[],
  ms: number,
  firstFailure: FirstFailure | null,
): ConfigReport {
  const sum = (f: (s: SeedSummary) => number) => summaries.reduce((a, s) => a + f(s), 0);
  return {
    name: config.name,
    toggles: config.toggles,
    seeds: summaries.length,
    failed: sum((s) => (s.ok ? 0 : 1)),
    crashes: sum((s) => s.crashes),
    overMicros: sum((s) => s.overMicros),
    underMicros: sum((s) => s.underMicros),
    violations: sum((s) => (s.violation ? 1 : 0)),
    dropMismatches: sum((s) => (s.dropsMatch ? 0 : 1)),
    firstFailure,
    ms,
  };
}

/** A toggle passes the torture test when it fails at least one seed; "all on" when it fails none. */
export function verdict(r: ConfigReport): "pass" | "FAIL" {
  return r.toggles.length === 0 ? (r.failed === 0 ? "pass" : "FAIL") : r.failed > 0 ? "pass" : "FAIL";
}

export function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const pct = (a: number, b: number) => (b === 0 ? "0%" : `${((100 * a) / b).toFixed(a === b || a === 0 ? 0 : 1)}%`);

export function renderMarkdown(reports: readonly ConfigReport[], meta: { p: number; command: string }): string {
  const lines = [
    "# Torture results",
    "",
    `\`${meta.command}\`, crash probability ${meta.p} at every crash point, default workload (PLAN.md).`,
    "",
    "| Config | Seeds | Failed seeds | Over-billed | Under-billed | Invariant violations | Crashes injected | Verdict |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const r of reports) {
    lines.push(
      `| ${r.toggles.length ? `\`${r.name}\`` : r.name} | ${r.seeds} | ${r.failed} (${pct(r.failed, r.seeds)}) | ${formatUsd(r.overMicros)} | ${formatUsd(r.underMicros)} | ${r.violations} | ${r.crashes.toLocaleString("en-US")} | ${verdict(r)} |`,
    );
  }
  lines.push(
    "",
    "Verdict: \"all safeguards on\" passes with 0 failed seeds; each break-it toggle passes when it fails at least one seed.",
    "",
    "## First failing seed per toggle",
    "",
  );
  for (const r of reports) {
    if (!r.firstFailure) continue;
    const f = r.firstFailure;
    lines.push(
      `### \`${r.name}\`: seed ${f.seed}`,
      "",
      `${f.reason}; ${f.mismatchedRows} ledger rows differ; ${f.crashCount} crashes in the run.`,
      "",
      "```",
      ...(f.crashTrace.length ? f.crashTrace : ["(no crashes: the failure needs none)"]),
      ...(f.crashCount > f.crashTrace.length ? [`... ${f.crashCount - f.crashTrace.length} more`] : []),
      "```",
      "",
    );
  }
  return lines.join("\n");
}

export { formatSimEvent };
