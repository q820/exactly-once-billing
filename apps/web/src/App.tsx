import { activeToggles, halfHour, type Safeguards } from "@eob/engine";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Controller } from "./controller.js";
import { elapsed } from "./format.js";
import { Inspector, LedgerPanel, Lanes, Narration, PipelineStrip, SafeguardsPanel } from "./panels.js";
import { SCENARIOS, type RunSpec } from "./scenarios.js";
import { CrashTestPanel } from "./CrashTestPanel.js";

const SPEEDS = [1, 5, 25, 100] as const;
const CRASH_RATES = [0, 0.001, 0.01, 0.05] as const;
/** UI only: the engine stays a pure function of its seeds; the chosen seed is shown so any run can be replayed. */
const newCrashSeed = () => Math.floor(Math.random() * 2 ** 32);

export function App() {
  const [scenarioIdx, setScenarioIdx] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);
  const scenario = SCENARIOS[scenarioIdx]!;
  const step = scenario.steps[stepIdx]!;
  const [ctrl, setCtrl] = useState(() => new Controller(step.spec));
  const [customLabel, setCustomLabel] = useState<string | null>(null);
  /** Safeguards changed by hand on top of the current step: keep the scenario header, just mark it. */
  const [modified, setModified] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(5);
  const [selected, setSelected] = useState(step.focusPartition);
  const [inspect, setInspect] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((t) => t + 1), []);
  const raf = useRef(0);

  const load = useCallback((spec: RunSpec, focus: number, label: string | null) => {
    setPlaying(false);
    setCtrl(new Controller(spec));
    setSelected(focus);
    setInspect(null);
    setCustomLabel(label);
    setModified(false);
  }, []);

  const goScenario = (i: number, s = 0) => {
    const sc = SCENARIOS[i]!;
    setScenarioIdx(i);
    setStepIdx(s);
    load(sc.steps[s]!.spec, sc.steps[s]!.focusPartition, null);
  };

  useEffect(() => {
    if (!playing) return;
    const frame = () => {
      const more = ctrl.advance(speed);
      rerender();
      if (more) raf.current = requestAnimationFrame(frame);
      else setPlaying(false);
    };
    raf.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, ctrl, rerender]);

  /** Flip a toggle: same seed, same crashes (including ones armed live), replayed up to the current sim time. */
  const [rerollOnRestart, setRerollOnRestart] = useState(true);

  /** Change part of the spec (Sandbox): same seed and crashes so far, replayed up to the current sim time. */
  const changeSpec = (patch: Partial<RunSpec>) => {
    const t = ctrl.sim.now;
    const next = new Controller({ ...ctrl.spec, crashes: ctrl.replayCrashes(), ...patch });
    next.runUntil(t);
    setPlaying(false);
    setCtrl(next);
    setModified(true);
  };
  const changeSafeguards = (s: Safeguards) => changeSpec({ safeguards: s });

  const replaySame = () => {
    const reroll = editable && rerollOnRestart && ctrl.spec.crashProbability > 0;
    const next = new Controller({ ...ctrl.spec, crashes: ctrl.replayCrashes(), ...(reroll ? { crashSeed: newCrashSeed() } : {}) });
    setPlaying(false);
    setCtrl(next);
  };

  const status = ctrl.status();
  const suggestions = useMemo(() => {
    const out: { label: string; ids: string[] }[] = [];
    const w = ctrl.sim.workload;
    if (scenario.spotlight === "late") {
      const late = [...w.kindOf].filter(([, k]) => k === "late").map(([m]) => m);
      const lag = (m: string) => {
        const e = w.events.find((x) => x.messageId === m)!;
        return Math.abs(e.appendedAt - e.deliveredAt - 21 * 86_400_000);
      };
      out.push({ label: "late (closest to 3 weeks first)", ids: late.sort((a, b) => lag(a) - lag(b)) });
      out.push({ label: "past retention", ids: [...w.kindOf].filter(([, k]) => k === "pastRetention").map(([m]) => m) });
    }
    return out;
  }, [ctrl, scenario]);
  const lost = status.drained && scenario.spotlight === "lost" ? ctrl.lostMessages() : [];

  const isCrashTest = scenario.crashTest === true;
  /** Guided scenarios and crash-test replays show their settings read-only; only the Sandbox is editable. */
  const editable = scenario.sandbox === true && customLabel === null;
  const start = ctrl.sim.config.workload.startMs;
  return (
    <div className="app">
      <header className="header">
        <div className="title">
          <strong>Exactly-once delivery billing</strong>
          <span className="muted"> · crash it anywhere</span>
        </div>
        <select value={scenarioIdx} onChange={(e) => goScenario(Number(e.target.value))}>
          {SCENARIOS.map((s, i) => (
            <option key={s.id} value={i}>
              {s.title}
            </option>
          ))}
        </select>
        {!isCrashTest ? (
          <>
            <span className="mono muted">
              seed {ctrl.spec.seed}
              {ctrl.spec.crashProbability > 0 ? ` · crash seed ${ctrl.spec.crashSeed ?? ctrl.spec.seed}` : ""}
            </span>
            <button className="primary" onClick={() => setPlaying(!playing)} disabled={status.drained}>
              {playing ? "Pause" : "Play"}
            </button>
            <button
              onClick={() => {
                ctrl.runToEnd();
                rerender();
              }}
              disabled={status.drained}
            >
              Run to end
            </button>
            <label className="muted">
              speed{" "}
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value) as (typeof SPEEDS)[number])}>
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s} events/frame
                  </option>
                ))}
              </select>
            </label>
            <button onClick={replaySame} title="Same seed, same crashes, from the start">
              Restart
            </button>
            <span className="mono muted">sim {elapsed(ctrl.sim.now - start)}</span>
            <span className={`pill ${status.kind}`}>{status.label}</span>
          </>
        ) : null}
      </header>

      <section className="scenario">
        <h1>
          {customLabel ?? scenario.title}
          {modified ? <span className="tag modified">safeguards changed</span> : null}
        </h1>
        <p>{customLabel ? describeSpec(ctrl.spec) : scenario.summary}</p>
        {!isCrashTest && !customLabel ? (
          <div className="steps">
            {scenario.steps.map((s, i) => (
              <button
                key={s.label}
                className={i === stepIdx && !modified ? "active" : ""}
                onClick={() => {
                  setStepIdx(i);
                  load(s.spec, s.focusPartition, null);
                }}
              >
                {i + 1}. {s.label}
              </button>
            ))}
            <span className="expect">
              {modified ? (
                <>
                  {describeSpec(ctrl.spec)}{" "}
                  <button className="link" onClick={() => load(step.spec, step.focusPartition, null)}>
                    Reset to step {stepIdx + 1}
                  </button>
                </>
              ) : (
                <>
                  {step.narration} <span className="muted">Expected: {expectLabel(step.expect)}.</span>
                </>
              )}
            </span>
          </div>
        ) : null}
      </section>

      {isCrashTest ? (
        <CrashTestPanel
          onReplay={(spec, label) => {
            setScenarioIdx(0);
            load(spec, 0, `Crash test replay: ${label}`);
          }}
        />
      ) : (
        <main className="grid">
          <div className="col">
            <PipelineStrip ctrl={ctrl} partition={selected} editable={editable} onArm={rerender}>
              {editable ? (
                <div className="random-crashes">
                  <label>
                    Random crashes{" "}
                    <select
                      value={ctrl.spec.crashProbability}
                      onChange={(e) => changeSpec({ crashProbability: Number(e.target.value) })}
                    >
                      {CRASH_RATES.map((r) => (
                        <option key={r} value={r}>
                          {r ? `p = ${r} at every crash point` : "off"}
                        </option>
                      ))}
                    </select>
                  </label>
                  {ctrl.spec.crashProbability > 0 ? (
                    <>
                      <button onClick={() => changeSpec({ crashSeed: newCrashSeed() })} title="Same workload, different random crashes">
                        New crash seed
                      </button>
                      <label className="muted">
                        <input type="checkbox" checked={rerollOnRestart} onChange={(e) => setRerollOnRestart(e.target.checked)} /> new crash seed on
                        every Restart
                      </label>
                    </>
                  ) : null}
                </div>
              ) : null}
            </PipelineStrip>
            <Lanes ctrl={ctrl} selected={selected} onSelect={setSelected} />
            <LedgerPanel ctrl={ctrl} status={status} onInspect={setInspect} />
          </div>
          <div className="col side">
            <SafeguardsPanel safeguards={ctrl.spec.safeguards} onChange={editable ? changeSafeguards : null} />
            <Inspector
              ctrl={ctrl}
              messageId={inspect}
              onInspect={setInspect}
              suggestions={[...suggestions, ...(lost.length ? [{ label: "lost (billed by the oracle, not the engine)", ids: lost }] : [])]}
            />
            <Narration ctrl={ctrl} />
          </div>
        </main>
      )}
      <footer className="muted">
        Late rows: half-hour buckets before {new Date(halfHour(start) * 1_800_000).toISOString().slice(0, 16)}Z. Money is integer micros.
      </footer>
    </div>
  );
}

function describeSpec(spec: RunSpec): string {
  const off = activeToggles(spec.safeguards);
  return [
    `Seed ${spec.seed}.`,
    off.length ? `Safeguards off: ${off.join(", ")}.` : "All safeguards on.",
    spec.crashProbability ? `Random crashes with p = ${spec.crashProbability} at every crash point (crash seed ${spec.crashSeed ?? spec.seed}).` : "",
    spec.crashes.length ? `Scripted crashes: ${spec.crashes.map((c) => `P${c.partition} batch ${c.batchIdx} at ${c.point}`).join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function expectLabel(o: string): string {
  return o === "green" ? "green, ledger matches oracle" : o === "over" ? "red, over-billed" : o === "under" ? "red, under-billed" : "red";
}
