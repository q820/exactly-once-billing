import {
  halfHour,
  partitionFor,
  TOGGLES,
  type CrashPoint,
  type LaneState,
  type Phase,
  type Safeguards,
  type TotalsDiffRow,
} from "@eob/engine";
import { eventKey } from "@eob/oracle";
import { useMemo, useState } from "react";
import type { Controller, Status } from "./controller.js";
import { bid, days, elapsed, halfHourLabel, signedUsd, timeLabel, usd } from "./format.js";

/* ---------- Partition lanes ---------- */

export function Lanes(props: { ctrl: Controller; selected: number; onSelect: (p: number) => void }) {
  const lanes = props.ctrl.sim.laneStates();
  const max = Math.max(1, ...lanes.map((l) => l.logEnd + 1));
  return (
    <section className="panel lanes">
      <h2>Partitions</h2>
      <div className="lane-legend mono">
        <span className="key committed" /> committed <span className="key planned" /> planned <span className="key log" /> log end
      </div>
      {lanes.map((l) => (
        <Lane key={l.partition} lane={l} max={max} now={props.ctrl.sim.now} selected={l.partition === props.selected} onSelect={props.onSelect} />
      ))}
    </section>
  );
}

function Lane(props: { lane: LaneState; max: number; now: number; selected: boolean; onSelect: (p: number) => void }) {
  const { lane: l, max } = props;
  const pct = (offset: number) => `${(100 * (offset + 1)) / max}%`;
  const down = l.status === "restarting";
  return (
    <button className={`lane ${props.selected ? "selected" : ""} ${down ? "down" : ""}`} onClick={() => props.onSelect(l.partition)}>
      <span className="mono lane-id">P{l.partition}</span>
      <span className="logbar" title={`committed ${l.committedEnd} · planned ${l.plannedEnd} · log end ${l.logEnd}`}>
        <span className="bar log" style={{ width: pct(l.logEnd) }} />
        <span className="bar planned" style={{ width: pct(l.plannedEnd) }} />
        <span className="bar committed" style={{ width: pct(l.committedEnd) }} />
      </span>
      <span className="mono lane-offsets">
        {l.committedEnd + 1}/{l.logEnd + 1}
      </span>
      <span className="mono lane-state">
        {down ? (
          <span className="warn">restarting in {Math.max(0, Math.ceil(((l.restartAt ?? props.now) - props.now) / 1000))}s</span>
        ) : (
          <>
            {l.worker?.phase === "plan" && l.committedEnd === l.logEnd ? "idle" : "running"} · e{l.epoch} · {bid(l.worker?.plan?.id)}
            {l.worker?.isReplay ? <span className="tag">replay</span> : null}
          </>
        )}
      </span>
    </button>
  );
}

/* ---------- Pipeline strip ---------- */

interface StripStep {
  readonly key: string;
  readonly phase: Phase;
  readonly label: string;
  readonly mid?: CrashPoint;
  readonly after?: CrashPoint;
  /** Shown in red: the step a disabled safeguard moved. */
  readonly broken?: string;
  /** Hover text for the box. */
  readonly tip?: string;
}

const STEPS: readonly StripStep[] = [
  {
    key: "plan",
    phase: "plan",
    label: "Plan",
    after: "C1",
    tip: "Fix the batch's offset range and BatchId before reading. After a restart, an uncommitted plan is reused as is (same range, same BatchId) and the batch replays; otherwise the next batch is planned.",
  },
  { key: "read", phase: "read", label: "Read" },
  { key: "filter", phase: "filter", label: "Filter" },
  { key: "dedup", phase: "writeDedup", label: "Dedup", mid: "C2a", after: "C2" },
  { key: "aggregate", phase: "aggregate", label: "Aggregate" },
  { key: "sink", phase: "sink", label: "Sink", mid: "C3a", after: "C3" },
  { key: "commit", phase: "commit", label: "Commit", after: "C4" },
];

/**
 * atMostOnce (commitLast off): the worker writes the commit at the start of the sink step,
 * after aggregation and before the first sink write. The last step still runs, but its commit
 * is a repeat with no effect; it only expires dedup entries.
 */
const AT_MOST_ONCE_STEPS: readonly StripStep[] = [
  ...STEPS.slice(0, -2),
  { key: "early-commit", phase: "sink", label: "Commit", broken: "atMostOnce: committed here, after aggregation and before the sink writes. A crash during the sink writes (C3a) loses the rows not yet written." },
  STEPS[STEPS.length - 2]!,
  { key: "commit", phase: "commit", label: "Expire", after: "C4" },
];

/** How recovery differs under atMostOnce. Before the early commit, the batch still replays normally. */
const AT_MOST_ONCE_RECOVERY: Partial<Record<CrashPoint, string>> = {
  C3a: "atMostOnce: the batch is already committed, so recovery skips it. The rows not yet written are lost.",
  C3: "atMostOnce: every row was already written, so skipping the batch loses nothing.",
};

/** What has survived in the stores when the worker dies at each point, and what recovery does about it. */
export const CRASH_POINT_INFO: Record<CrashPoint, { when: string; state: string; recovery: string }> = {
  C1: {
    when: "After the plan is written, before reading",
    state: "Only the batch range (offsets and BatchId) is saved. Nothing is deduped or billed yet.",
    recovery: "The restarted worker replays exactly that range under the same BatchId.",
  },
  C2a: {
    when: "Halfway through the dedup writes",
    state: "Some of the batch's messageIds are marked as seen by this BatchId, the rest aren't. Nothing is billed yet.",
    recovery: "The replay finds entries tagged with its own BatchId and keeps those messages instead of treating them as duplicates.",
  },
  C2: {
    when: "After all dedup writes, before the sink",
    state: "Every message in the batch is marked as seen, but none is billed.",
    recovery: "The replay recognises all the entries as its own (same BatchId) and bills every message.",
  },
  C3a: {
    when: "Halfway through the sink writes",
    state: "Some ledger rows already carry this batch's delta (lastApplied = this BatchId), the rest don't.",
    recovery: "The replay's compare-and-set rejects the rows already written and applies the rest. No rollback needed.",
  },
  C3: {
    when: "After all sink writes, before the commit",
    state: "Everything is billed, but the batch isn't committed, so recovery can't know it's done.",
    recovery: "The replay re-runs the whole batch; every row's compare-and-set rejects the second write.",
  },
  C4: {
    when: "After the commit",
    state: "The batch is done and committed.",
    recovery: "Nothing to replay: the restarted worker plans the next batch.",
  },
};

/** Top-level so React keeps the same button across re-renders (keeps hover, focus and clicks while playing). */
function Bolt(props: {
  point: CrashPoint;
  partition: number;
  armed: boolean;
  scripted: number[];
  atMostOnce: boolean;
  onClick: (() => void) | null;
}) {
  const info = CRASH_POINT_INFO[props.point];
  const recovery = (props.atMostOnce && AT_MOST_ONCE_RECOVERY[props.point]) || info.recovery;
  const scripted = props.scripted.length > 0;
  const action = scripted
    ? `This step crashes P${props.partition} here during batch ${props.scripted.join(", ")}.`
    : props.onClick === null
      ? "Open the Sandbox scenario to arm crashes yourself."
      : props.armed
        ? `Armed for P${props.partition}: click to disarm.`
        : `Click to crash P${props.partition} the next time it reaches ${props.point}.`;
  return (
    <span className="bolt-wrap">
      <button
        className={`bolt ${props.armed || scripted ? "armed" : ""} ${props.onClick ? "" : "locked"}`}
        aria-describedby={`tip-${props.point}`}
        aria-disabled={props.onClick === null}
        onClick={props.onClick ?? undefined}
      >
        ⚡<span className="mono">{props.point}</span>
      </button>
      <span className="tip" role="tooltip" id={`tip-${props.point}`}>
        <strong>
          {props.point}: {info.when}
        </strong>
        <span>{info.state}</span>
        <span className={recovery === info.recovery ? "" : "bad-text"}>{recovery}</span>
        <span className="tip-action">{action}</span>
      </span>
    </span>
  );
}

export function PipelineStrip(props: { ctrl: Controller; partition: number; editable: boolean; onArm: () => void; children?: React.ReactNode }) {
  const { ctrl, partition } = props;
  const lane = ctrl.sim.lane(partition);
  const w = lane.worker;
  const armed = new Set(ctrl.armed.filter((a) => a.partition === partition).map((a) => a.point));
  const atMostOnce = !ctrl.spec.safeguards.commitLast;
  const steps = atMostOnce ? AT_MOST_ONCE_STEPS : STEPS;
  const scriptedAt = (point: CrashPoint) => ctrl.spec.crashes.filter((c) => c.partition === partition && c.point === point).map((c) => c.batchIdx);
  const bolt = (point: CrashPoint) => (
    <Bolt
      point={point}
      partition={partition}
      armed={armed.has(point)}
      scripted={scriptedAt(point)}
      atMostOnce={atMostOnce}
      onClick={
        props.editable
          ? () => {
              ctrl.arm(partition, point);
              props.onArm();
            }
          : null
      }
    />
  );
  return (
    <section className="panel pipeline">
      <h2>
        Crash points · P{partition}{" "}
        <span className="mono muted">
          {lane.status === "restarting"
            ? "worker down"
            : `epoch ${lane.epoch} · batch ${bid(w?.plan?.id)}${w?.plan ? ` · offsets ${w.plan.startOffset}–${w.plan.endOffset}` : ""}`}
        </span>
        {w?.isReplay ? <span className="tag">replay</span> : null}
      </h2>
      {props.children}
      <div className="strip">
        {steps.map((s) => (
          <div key={s.key} className="step-wrap">
            <div
              className={`step ${w?.phase === s.phase || (s.key === "plan" && w?.phase === "recover") ? "next" : ""} ${s.broken ? "broken" : ""}`}
              title={s.broken ?? s.tip}
            >
              {s.label}
              {s.mid ? bolt(s.mid) : null}
            </div>
            {s.after ? bolt(s.after) : <span className="gap" />}
          </div>
        ))}
      </div>
      <p className="hint">
        Each box is one protocol step of P{partition}'s worker; highlighted = runs next. Hover a ⚡ for what a crash there leaves behind.{" "}
        {props.editable ? `Click one to crash P${partition} the next time it gets there.` : "A lit ⚡ is the crash this step injects."}
        {atMostOnce ? " With atMostOnce the commit moves up to right before the sink writes; the last step only expires dedup entries (its commit is a no-op repeat)." : ""}
      </p>
    </section>
  );
}

/* ---------- Ledger ---------- */

export function LedgerPanel(props: { ctrl: Controller; status: Status; onInspect: (m: string) => void }) {
  const { ctrl, status } = props;
  const [onlyMismatched, setOnlyMismatched] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const startBucket = halfHour(ctrl.sim.config.workload.startMs);
  const messagesByRow = useMemo(() => {
    const m = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const e of ctrl.sim.workload.events) {
      if (ctrl.oracle.drops.has(eventKey(e)) || seen.has(e.messageId)) continue;
      seen.add(e.messageId);
      const k = `${e.account}|${e.sku}|${halfHour(e.deliveredAt)}`;
      m.set(k, [...(m.get(k) ?? []), e.messageId]);
    }
    return m;
  }, [ctrl]);

  const rows = status.diff.rows
    .filter((r) => !onlyMismatched || isBad(r, status.drained))
    .sort((a, b) => Number(isBad(b, status.drained)) - Number(isBad(a, status.drained)) || a.key.localeCompare(b.key));
  const shown = rows.slice(0, 300);
  return (
    <section className="panel ledger">
      <h2>
        Ledger vs oracle{" "}
        <span className="muted mono">
          {status.diff.rows.length} rows · engine {usd(sum(status.diff.rows, "actual"))} · oracle {usd(sum(status.diff.rows, "expected"))}
        </span>
      </h2>
      <label className="check">
        <input type="checkbox" checked={onlyMismatched} onChange={(e) => setOnlyMismatched(e.target.checked)} /> only mismatched rows (
        {status.diff.rows.filter((r) => isBad(r, status.drained)).length})
      </label>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>SKU</th>
              <th>Half-hour (UTC)</th>
              <th className="num">Engine</th>
              <th className="num">Oracle</th>
              <th className="num">Diff</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const [account, sku, hh] = r.key.split("|") as [string, string, string];
              const late = Number(hh) < startBucket - 1;
              const bad = isBad(r, status.drained);
              const pending = !status.drained && r.diff < 0;
              return (
                <FragmentRow key={r.key}>
                  <tr className={`${bad ? "bad" : ""} ${pending ? "pending" : ""}`} onClick={() => setOpen(open === r.key ? null : r.key)}>
                    <td className="mono">{account}</td>
                    <td>{sku}</td>
                    <td className="mono">
                      {halfHourLabel(Number(hh))} {late ? <span className="tag late">late</span> : null}
                    </td>
                    <td className="num mono">{usd(r.actual)}</td>
                    <td className="num mono">{usd(r.expected)}</td>
                    <td className="num mono">{r.diff === 0 ? "" : pending ? "pending" : signedUsd(r.diff)}</td>
                  </tr>
                  {open === r.key ? (
                    <tr className="expand">
                      <td colSpan={6}>
                        Billed by the oracle:{" "}
                        {(messagesByRow.get(r.key) ?? []).map((m) => (
                          <button key={m} className="link mono" onClick={() => props.onInspect(m)}>
                            {m}
                          </button>
                        ))}
                      </td>
                    </tr>
                  ) : null}
                </FragmentRow>
              );
            })}
          </tbody>
        </table>
        {rows.length > shown.length ? <p className="hint">{rows.length - shown.length} more rows not shown.</p> : null}
      </div>
    </section>
  );
}

function FragmentRow(props: { children: React.ReactNode }) {
  return <>{props.children}</>;
}

const isBad = (r: TotalsDiffRow, drained: boolean) => r.diff > 0 || (drained && r.diff < 0);
const sum = (rows: readonly TotalsDiffRow[], k: "actual" | "expected") => rows.reduce((s, r) => s + r[k], 0);

/* ---------- Safeguards ---------- */

export function SafeguardsPanel(props: { safeguards: Safeguards; onChange: ((s: Safeguards) => void) | null }) {
  const off = TOGGLES.filter((t) => !props.safeguards[t.safeguard]).length;
  return (
    <section className="panel safeguards">
      <h2>
        Safeguards <span className="muted">· the rules that make recovery exactly-once</span>
      </h2>
      <p className="hint">
        Crashes (⚡ in the pipeline) are the failure. Safeguards are the defence: with all four on, no crash changes the bill.{" "}
        {props.onChange
          ? "Uncheck one to see the billing error it prevents; the same seed and crashes replay up to the current time."
          : "Set by this step: the step buttons above flip them. Open the Sandbox scenario to change them yourself."}
      </p>
      {TOGGLES.map((t) => {
        const on = props.safeguards[t.safeguard];
        return (
          <label key={t.name} className={`toggle ${on ? "" : "off"} ${props.onChange ? "" : "locked"}`} title={`Off = ${t.name}. Exposed by: ${t.exposedBy}. ${t.teaches}.`}>
            <input
              type="checkbox"
              checked={on}
              disabled={!props.onChange}
              onChange={() => props.onChange?.({ ...props.safeguards, [t.safeguard]: !on })}
            />
            <span className="rule">
              <span className="rule-name">{t.rule}</span>
              <span className="mono rule-state">{on ? "on" : `off: ${t.name}`}</span>
            </span>
            <span className="desc">{on ? t.ruleDescription : t.description}</span>
          </label>
        );
      })}
      <p className="hint">{off === 0 ? "All safeguards on: exactly-once." : `${off} off: expect the ledger to diverge once a crash exposes it.`}</p>
    </section>
  );
}

/* ---------- Event inspector ---------- */

export function Inspector(props: { ctrl: Controller; messageId: string | null; suggestions: { label: string; ids: string[] }[]; onInspect: (m: string) => void }) {
  const { ctrl, messageId } = props;
  const [query, setQuery] = useState("");
  const sim = ctrl.sim;
  const copies = messageId ? sim.workload.events.filter((e) => e.messageId === messageId) : [];
  const p = messageId ? partitionFor(messageId, sim.config.partitions) : 0;
  const records = messageId ? sim.stores.source.read(p, 0, sim.stores.source.endOffset(p)).filter((r) => r.messageId === messageId) : [];
  const entry = messageId ? sim.stores.dedup[p]!.get(messageId) : undefined;
  const first = copies.find((c) => !ctrl.oracle.drops.has(eventKey(c)));
  const rowKey = first ? `${first.account}|${first.sku}|${halfHour(first.deliveredAt)}` : null;
  const row = rowKey ? ctrl.status().diff.rows.find((r) => r.key === rowKey) : undefined;
  return (
    <section className="panel inspector">
      <h2>Event inspector</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) props.onInspect(query.trim());
        }}
      >
        <input className="mono" placeholder="messageId, e.g. m0042" value={query} onChange={(e) => setQuery(e.target.value)} />
      </form>
      {props.suggestions.map((s) =>
        s.ids.length ? (
          <div key={s.label} className="suggest">
            <span className="muted">{s.label}:</span>
            {s.ids.slice(0, 6).map((m) => (
              <button key={m} className="link mono" onClick={() => props.onInspect(m)}>
                {m}
              </button>
            ))}
          </div>
        ) : null,
      )}
      {messageId && copies.length === 0 ? <p className="hint">No message {messageId} in this workload.</p> : null}
      {messageId && copies.length > 0 ? (
        <>
          <p className="mono">
            {messageId} · {copies[0]!.account} · {copies[0]!.sku} · {usd(copies[0]!.priceMicros)} · P{p} · sent{" "}
            {timeLabel(copies[0]!.sentAt)}
          </p>
          <table>
            <thead>
              <tr>
                <th>Copy</th>
                <th>Offset</th>
                <th>Appended</th>
                <th>Delivered (bucket)</th>
                <th>Decisions (batch: verdict)</th>
              </tr>
            </thead>
            <tbody>
              {copies.map((c) => {
                const rec = records.find((r) => r.deviceId === c.deviceId && r.appendedAt === c.appendedAt);
                const ds = rec ? (ctrl.decisions.get(`${p}:${rec.offset}`) ?? []) : [];
                const age = c.appendedAt - c.sentAt;
                return (
                  <tr key={eventKey(c)}>
                    <td className="mono">{c.deviceId}</td>
                    <td className="mono">{rec ? rec.offset : "not yet appended"}</td>
                    <td className="mono">
                      {timeLabel(c.appendedAt)}
                      <div className="muted">{days(age)} after send</div>
                    </td>
                    <td className="mono">{halfHourLabel(halfHour(c.deliveredAt))}</td>
                    <td className="mono">
                      {ds.length === 0 ? <span className="muted">not processed yet</span> : null}
                      {ds.map((d, i) => (
                        <div key={i} className={d.decision === "kept" ? "" : "muted"}>
                          {bid(d.batchId)}
                          {d.isReplay ? " replay" : ""}: {d.decision}
                        </div>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mono">
            Dedup entry: {entry ? `${bid(entry.id)}, seen ${timeLabel(entry.seenAt)}` : <span className="muted">none</span>}
          </p>
          <p className="mono">
            Oracle:{" "}
            {first
              ? `bills ${first.deviceId} into ${first.account} · ${first.sku} · ${halfHourLabel(halfHour(first.deliveredAt))}`
              : "drops every copy (past retention)"}
            {row ? ` · row engine ${usd(row.actual)} / oracle ${usd(row.expected)}` : ""}
          </p>
        </>
      ) : null}
    </section>
  );
}

/* ---------- Narration ---------- */

export function Narration(props: { ctrl: Controller }) {
  const start = props.ctrl.sim.config.workload.startMs;
  const lines = props.ctrl.narration.slice(-80).reverse();
  return (
    <section className="panel narration">
      <h2>Narration</h2>
      <ol>
        {lines.length === 0 ? <li className="muted">Nothing notable yet. Crashes, replays and drops show up here.</li> : null}
        {lines.map((l, i) => (
          <li key={i} className={l.tone ?? ""}>
            <span className="mono muted">{elapsed(l.t - start)}</span> {l.text}
          </li>
        ))}
      </ol>
    </section>
  );
}
