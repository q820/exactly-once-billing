/**
 * The four rules that make the pipeline exactly-once, one safeguard each. (Dedup by
 * messageId and replays keeping their BatchId are always on: the first predates
 * exactly-once, the second is part of rule 2.)
 * All on by default. Each break-it toggle turns exactly one off, and the worker
 * reads them only from this object (PLAN.md, "Break-it toggles").
 */
export interface Safeguards {
  /** Commit after the sink writes, not before them. */
  readonly commitLast: boolean;
  /** A dedup entry from the current batch id is our own earlier attempt, not a duplicate. */
  readonly dedupChecksBatchId: boolean;
  /** A replay reads exactly its planned range. */
  readonly deterministicBatches: boolean;
  /** Sink writes are compare-and-set on the batch id. */
  readonly casSink: boolean;
}

export const ALL_SAFEGUARDS: Safeguards = {
  commitLast: true,
  dedupChecksBatchId: true,
  deterministicBatches: true,
  casSink: true,
};

export type ToggleName =
  | "atMostOnce"
  | "dedupIgnoresBatchId"
  | "nondeterministicBatches"
  | "atLeastOnce";

export interface ToggleInfo {
  readonly name: ToggleName;
  readonly safeguard: keyof Safeguards;
  /** The safeguard as a short rule name, for the UI. */
  readonly rule: string;
  /** What the safeguard guarantees, one line. */
  readonly ruleDescription: string;
  /** What breaks when it is off, one line. */
  readonly description: string;
  readonly exposedBy: string;
  readonly result: "over" | "under" | "diverges";
  readonly teaches: string;
}

export const TOGGLES: readonly ToggleInfo[] = [
  {
    name: "nondeterministicBatches",
    safeguard: "deterministicBatches",
    rule: "Replay reads its plan",
    ruleDescription: "A replay reads exactly the offset range written in its plan.",
    description: "On recovery, read whatever is available up to a random size",
    exposedBy: "Crash at C2",
    result: "under",
    teaches: "Why the plan is written before reading",
  },
  {
    name: "dedupIgnoresBatchId",
    safeguard: "dedupChecksBatchId",
    rule: "Dedup knows its own batch",
    ruleDescription: "An entry tagged with this BatchId is our own earlier attempt, not a duplicate.",
    description: "Any existing dedup key counts as a duplicate",
    exposedBy: "Crash at C2 or C3a",
    result: "under",
    teaches: "Why a dedup entry carries a BatchId",
  },
  {
    name: "atLeastOnce",
    safeguard: "casSink",
    rule: "Compare-and-set sink",
    ruleDescription: "A ledger row applies a batch only if lastApplied < BatchId, so a replay can't add twice.",
    description: "Adds the delta without a CAS check: a replay bills its rows a second time",
    exposedBy: "Crash at C3 or C3a",
    result: "over",
    teaches: "Why the sink write must be conditional",
  },
  {
    name: "atMostOnce",
    safeguard: "commitLast",
    rule: "Commit last",
    ruleDescription: "A batch is committed only after all its sink writes, so a crash mid-batch replays it.",
    description: "Commits before the sink writes: a crash mid-sink skips the rows not yet written",
    exposedBy: "Crash at C3a",
    result: "under",
    teaches: "Why committing before the sink write loses revenue",
  },
];

export function toggleInfo(name: ToggleName): ToggleInfo {
  const t = TOGGLES.find((x) => x.name === name);
  if (!t) throw new Error(`unknown toggle ${name}`);
  return t;
}

/** All safeguards on except the ones the given toggles remove. */
export function breakIt(...toggles: ToggleName[]): Safeguards {
  const s: Record<keyof Safeguards, boolean> = { ...ALL_SAFEGUARDS };
  for (const t of toggles) s[toggleInfo(t).safeguard] = false;
  return s;
}

export function activeToggles(s: Safeguards): ToggleName[] {
  return TOGGLES.filter((t) => !s[t.safeguard]).map((t) => t.name);
}
