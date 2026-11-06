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

const STEPS: { phase: Phase; label: string; mid?: CrashPoint; after?: CrashPoint }[] = [
  { phase: "plan", label: "Plan", after: "C1" },
  { phase: "read", label: "Read" },
  { phase: "filter", label: "Filter" },
  { phase: "writeDedup", label: "Dedup", mid: "C2a", after: "C2" },
  { phase: "aggregate", label: "Aggregate" },
  { phase: "sink", label: "Sink", mid: "C3a", after: "C3" },
  { phase: "commit", label: "Commit", after: "C4" },
];

export function PipelineStrip(props: { ctrl: Controller; partition: number; onArm: () => void }) {
  const { ctrl, partition } = props;
  const lane = ctrl.sim.lane(partition);
  const w = lane.worker;
  const armed = new Set(ctrl.armed.filter((a) => a.partition === partition).map((a) => a.point));
  const Bolt = ({ point }: { point: CrashPoint }) => (
    <button
      className={`bolt ${armed.has(point) ? "armed" : ""}`}
      title={armed.has(point) ? `${point} armed: click to disarm` : `Crash P${partition} the next time it reaches ${point}`}
      onClick={() => {
        ctrl.arm(partition, point);
        props.onArm();
      }}
    >
      ⚡<span className="mono">{point}</span>
    </button>
  );
  return (
    <section className="panel pipeline">
      <h2>
        Pipeline · P{partition}{" "}
        <span className="mono muted">
          {lane.status === "restarting"
            ? "worker down"
            : `epoch ${lane.epoch} · batch ${bid(w?.plan?.id)}${w?.plan ? ` · offsets ${w.plan.startOffset}–${w.plan.endOffset}` : ""}`}
        </span>
        {w?.isReplay ? <span className="tag">replay</span> : null}
      </h2>
      <div className="strip">
        {w?.phase === "recover" ? <div className="step next">Recover</div> : null}
        {STEPS.map((s) => (
          <div key={s.phase} className="step-wrap">
            <div className={`step ${w?.phase === s.phase ? "next" : ""}`}>
              {s.label}
              {s.mid ? <Bolt point={s.mid} /> : null}
            </div>
            {s.after ? <Bolt point={s.after} /> : <span className="gap" />}
          </div>
        ))}
      </div>
      <p className="hint">
        Highlighted = the step that runs next. ⚡ arms a crash for the next time P{partition} reaches that point (C2a/C3a: halfway
        through the writes).
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

export function SafeguardsPanel(props: { safeguards: Safeguards; onChange: (s: Safeguards) => void }) {
  return (
    <section className="panel safeguards">
      <h2>Safeguards</h2>
      <p className="hint">Turning one off replays the same seed and crashes up to the current time.</p>
      {TOGGLES.map((t) => {
        const on = props.safeguards[t.safeguard];
        return (
          <label key={t.name} className={`toggle ${on ? "" : "off"}`} title={`${t.exposedBy}. ${t.teaches}.`}>
            <input type="checkbox" checked={on} onChange={() => props.onChange({ ...props.safeguards, [t.safeguard]: !on })} />
            <span className="mono">{on ? t.safeguard : t.name}</span>
            <span className="desc">{on ? "on" : t.description}</span>
          </label>
        );
      })}
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
