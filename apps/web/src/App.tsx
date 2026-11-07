import { activeToggles, halfHour, type Safeguards } from "@eob/engine";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Controller } from "./controller.js";
import { elapsed } from "./format.js";
import { Inspector, LedgerPanel, Lanes, Narration, PipelineStrip, SafeguardsPanel } from "./panels.js";
import { SCENARIOS, type RunSpec } from "./scenarios.js";
import { CrashTestPanel } from "./CrashTestPanel.js";

const SPEEDS = [1, 5, 25, 100] as const;

export function App() {
  const [scenarioIdx, setScenarioIdx] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);
  const scenario = SCENARIOS[scenarioIdx]!;
  const step = scenario.steps[stepIdx]!;
  const [ctrl, setCtrl] = useState(() => new Controller(step.spec));
  const [customLabel, setCustomLabel] = useState<string | null>(null);
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
  const changeSafeguards = (s: Safeguards) => {
    const t = ctrl.sim.now;
    const next = new Controller({ ...ctrl.spec, safeguards: s, crashes: ctrl.replayCrashes() });
    next.runUntil(t);
    setPlaying(false);
    setCtrl(next);
    setCustomLabel("custom: safeguards changed");
  };

  const replaySame = () => {
    const next = new Controller({ ...ctrl.spec, crashes: ctrl.replayCrashes() });
    setPlaying(false);
    setCtrl(next);
  };

  const status = ctrl.status();
  const suggestions = useMemo(() => {
    const out: { label: string; ids: string[] }[] = [];
    const w = ctrl.sim.workload;
    if (scenario.spotlight === "late" || scenario.id === "phone") {
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
        <button onClick={() => goScenario((scenarioIdx + 1) % SCENARIOS.length)}>Next scenario →</button>
        {!isCrashTest ? (
          <>
            <span className="mono muted">seed {ctrl.spec.seed}</span>
            <button className="primary" onClick={() => setPlaying(!playing)} disabled={status.drained}>
              {playing ? "Pause" : "Play"}
            </button>
            <button
              onClick={() => {
                ctrl.advance(1);
                rerender();
              }}
              disabled={status.drained}
            >
              Step
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
              Replay
            </button>
            <span className="mono muted">sim {elapsed(ctrl.sim.now - start)}</span>
            <span className={`pill ${status.kind}`}>{status.label}</span>
          </>
        ) : null}
      </header>

      <section className="scenario">
        <h1>{customLabel ?? scenario.title}</h1>
        <p>{customLabel ? describeSpec(ctrl.spec) : scenario.summary}</p>
        {!isCrashTest && !customLabel ? (
          <div className="steps">
            {scenario.steps.map((s, i) => (
              <button
                key={s.label}
                className={i === stepIdx && !customLabel ? "active" : ""}
                onClick={() => {
                  setStepIdx(i);
                  load(s.spec, s.focusPartition, null);
                }}
              >
                {i + 1}. {s.label}
              </button>
            ))}
            <span className="expect">
              {step.narration} <span className="muted">Expected: {expectLabel(step.expect)}.</span>
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
            <PipelineStrip ctrl={ctrl} partition={selected} onArm={rerender} />
            <Lanes ctrl={ctrl} selected={selected} onSelect={setSelected} />
            <LedgerPanel ctrl={ctrl} status={status} onInspect={setInspect} />
          </div>
          <div className="col side">
            <SafeguardsPanel safeguards={ctrl.spec.safeguards} onChange={changeSafeguards} />
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
    spec.crashProbability ? `Random crashes with p = ${spec.crashProbability} at every crash point.` : "",
    spec.crashes.length ? `Scripted crashes: ${spec.crashes.map((c) => `P${c.partition} batch ${c.batchIdx} at ${c.point}`).join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function expectLabel(o: string): string {
  return o === "green" ? "green, ledger matches oracle" : o === "over" ? "red, over-billed" : o === "under" ? "red, under-billed" : "red";
}
