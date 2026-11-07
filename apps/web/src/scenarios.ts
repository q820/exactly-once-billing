import { ALL_SAFEGUARDS, breakIt, type Safeguards, type ScriptedCrash, type SimOverrides, type ToggleName } from "@eob/engine";

/** Everything a run is a pure function of. */
export interface RunSpec {
  readonly seed: number;
  readonly overrides: SimOverrides;
  readonly safeguards: Safeguards;
  readonly crashes: readonly ScriptedCrash[];
  /** Random crashes at every crash point (crash-test replays). */
  readonly crashProbability: number;
}

export type Outcome = "green" | "over" | "under" | "mixed";

export interface ScenarioStep {
  readonly label: string;
  /** What to watch for, in plain English. */
  readonly narration: string;
  readonly spec: RunSpec;
  readonly expect: Outcome;
  /** Partition to select in the pipeline strip. */
  readonly focusPartition: number;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly ScenarioStep[];
  /** Messages the inspector should offer ("late" or "dropped" or "lost"). */
  readonly spotlight?: "late" | "lost";
  readonly crashTest?: boolean;
}

/** Small enough to watch, big enough to have every kind of event. */
export const DEMO_OVERRIDES: SimOverrides = { workload: { messages: 1_500 }, maxBatch: 20, pollMs: 300_000 };
export const DEMO_SEED = 4;

export function spec(over: Partial<RunSpec> & { toggles?: ToggleName[] } = {}): RunSpec {
  const { toggles, ...rest } = over;
  return {
    seed: DEMO_SEED,
    overrides: DEMO_OVERRIDES,
    safeguards: toggles ? breakIt(...toggles) : ALL_SAFEGUARDS,
    crashes: [],
    crashProbability: 0,
    ...rest,
  };
}

const crashAt = (point: ScriptedCrash["point"], partition = 3, batchIdx = 2): ScriptedCrash[] => [
  { partition, batchIdx, point, isReplay: false },
];

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "normal",
    title: "1. Normal day",
    summary:
      "Duplicates from multi-device delivery and infra retries, plus phones that come online days late. No crashes. Every duplicate is filtered and late events land in their old half-hour buckets.",
    steps: [
      {
        label: "Run",
        narration: "Watch the lanes drain. The ledger matches the oracle; rows marked late are old buckets filled by late deliveries.",
        spec: spec(),
        expect: "green",
        focusPartition: 0,
      },
    ],
    spotlight: "late",
  },
  {
    id: "legacy",
    title: "2. The legacy pipeline",
    summary:
      "atMostOnce is on: the worker commits the batch range before processing it, the way the original at-most-once pipeline did. P3 crashes at C3a, halfway through its sink writes.",
    steps: [
      {
        label: "Crash at C3a with atMostOnce",
        narration:
          "On restart the batch already looks committed, so it is never replayed. The rows written before the crash survive; the rest are lost for good, and later copies of those messages are treated as duplicates.",
        spec: spec({ toggles: ["atMostOnce"], crashes: crashAt("C3a") }),
        expect: "under",
        focusPartition: 3,
      },
    ],
  },
  {
    id: "c2",
    title: "3. Crash after dedup, before sink",
    summary:
      "P3 crashes at C2: the dedup entries are written but nothing reached the sink. The replay must recognize its own entries by their BatchId.",
    steps: [
      {
        label: "Safeguards on",
        narration: "The replay finds entries stamped with its own BatchId and keeps those items. Green.",
        spec: spec({ crashes: crashAt("C2") }),
        expect: "green",
        focusPartition: 3,
      },
      {
        label: "Flip dedupIgnoresBatchId and replay",
        narration: "Now any existing entry means duplicate, so the replay throws away its own batch. Red, under-billed.",
        spec: spec({ toggles: ["dedupIgnoresBatchId"], crashes: crashAt("C2") }),
        expect: "under",
        focusPartition: 3,
      },
    ],
    spotlight: "lost",
  },
  {
    id: "shrink",
    title: "4. The shrinking replay",
    summary:
      "nondeterministicBatches is on: on recovery the worker reads whatever is available up to a random size instead of its planned range. P3 crashes at C2.",
    steps: [
      {
        label: "Crash at C2, replay reads fewer records",
        narration:
          "The replay commits a shorter range. The records it skipped already have dedup entries from the first attempt, so the next batch falsely dedupes them. Open a lost message in the inspector.",
        spec: spec({ toggles: ["nondeterministicBatches"], crashes: crashAt("C2") }),
        expect: "under",
        focusPartition: 3,
      },
    ],
    spotlight: "lost",
  },
  {
    id: "c3",
    title: "5. Crash after sink, before commit",
    summary: "P3 crashes at C3: the sink rows are written but the batch isn't committed, so it replays.",
    steps: [
      {
        label: "Safeguards on",
        narration: "The replay sends the same deltas again; every row's CAS rejects them (lastApplied is already this BatchId). Green.",
        spec: spec({ crashes: crashAt("C3") }),
        expect: "green",
        focusPartition: 3,
      },
      {
        label: "Flip blindUpsert and replay",
        narration: "Without the CAS check the replay adds its deltas a second time. Red, over-billed.",
        spec: spec({ toggles: ["blindUpsert"], crashes: crashAt("C3") }),
        expect: "over",
        focusPartition: 3,
      },
    ],
  },
  {
    id: "phone",
    title: "6. The phone that came back",
    summary:
      "A delivery from a phone that was offline for about three weeks lands in its three-week-old bucket through the normal path. A message sent more than 30 days before it was appended goes to the DropLog instead of the bill.",
    steps: [
      {
        label: "Run",
        narration: "Open the late message and the dropped one in the inspector. Both decisions use only record time, so a replay decides the same way.",
        spec: spec(),
        expect: "green",
        focusPartition: 0,
      },
    ],
    spotlight: "late",
  },
  {
    id: "crash-test",
    title: "7. Crash test",
    summary:
      "500 seeds with random crashes at every crash point, run in Web Workers: all safeguards on, then each toggle on its own.",
    steps: [
      {
        label: "Run 500 seeds",
        narration: "All-on must fail no seeds; every toggle must fail some.",
        spec: spec(),
        expect: "green",
        focusPartition: 0,
      },
    ],
    crashTest: true,
  },
];
