# Exactly-Once Delivery Billing — Build Plan

Source: [Claude Doc](https://claude.ai/artifact/LpXhuHe2epGRVTtZdbn9ZJ), copied 2026-11-04 (rev 14).

## Goal and pitch

We're building a browser-playable, crash-anywhere simulation of an exactly-once billing pipeline for message deliveries. A Node crash test kills it thousands of times and proves the ledger never over- or under-bills.

**Theme:** Systems & Reliability.

**The story:** I ported a real at-most-once streaming billing pipeline (Scribe/Stylus at Meta, comparable to Kafka/Flink) to exactly-once. This prototype distills that protocol into a small engine you can break on purpose.

**The non-obvious part:** exactly-once doesn't come from the framework. It comes from four small rules: deterministic batch boundaries, a dedup check that tells a replay apart from a duplicate, compare-and-set (CAS) sink writes keyed by batch id, and committing last. Each rule has a toggle, and turning one off produces a specific, visible billing error.

**Late events are normal, not a failure mode.** A phone can come online days later. Its delivery lands in an old half-hour bucket through the same path as any other event.

**What a reviewer sees in 60 seconds:** pick a scenario, click "crash here" between two pipeline steps, and watch the worker restart and replay. The ledger stays equal to an independently computed oracle. Then flip one safeguard off, replay the same seed, and watch the diff go red with dollars over- or under-billed.

**Time budget:** about 6 hours of build (hard cap 8), with a cut line after the crash test (see Milestones).

## Locked design decisions

These are settled. Claude Code should not reopen them without asking.

| Decision | Choice | Why |
| --- | --- | --- |
| Event types | Delivery events only. Price is fixed at send and carried on the event | Pricing on send, billing on delivery. Modeling the send→delivery join doubles the state work without adding a new idea |
| Sources of duplicates | The same message delivered to several devices, plus infra retries | Both produce the same messageId, so one dedup key covers both |
| Framework | Our own micro-batch engine in TypeScript (no Kafka, no Flink) | The contribution is the protocol, which is framework-agnostic. The closest real-world model is Spark Structured Streaming (an offset log plus batchId-idempotent sinks) |
| Partitioning | Fixed, generous count (default 8 in the demo), partition = hash(messageId) % P | All copies of a message land on one partition, so dedup is partition-local. A fixed count means no repartitioning |
| Worker failure | Static assignment. A dead worker's partitions lag until the platform restarts it, then it resumes from its own batch log | Billing tolerates delay, not error. No rebalancing means no zombie writers |
| Dedup retention | Flat 30-day TTL on the dedup store | WhatsApp commits to delivery within 30 days; one number for the TTL and the drop rule |
| Past retention | If appendedAt − sentAt > 30 days: log and drop, never bill | Rare. Billing it would risk a double-bill, and a surprise line on next month's invoice confuses businesses |
| Sink key | paymentAccount × sku × halfHour(deliveredAt) × partition. Invoices sum across partitions | One writer per row, so no read-modify-write contention between partitions |
| Money | Integer micros (bigint or safe integers), never floats | Totals stay exact |

## Architecture

The architecture has five durable stores and one stateless worker loop per partition. A crash wipes worker memory but never the stores. The engine depends only on the store interfaces and a Clock, so the same code runs in the browser simulation, in the Node crash test and, as a stretch goal, on SQLite.

The oracle reads the same events as the workers but shares no code with them, so it can disagree with the engine.

### Store interfaces

- **SourceLog:** `append(event)`, `read(partition, start, endInclusive)` and `endOffset(partition)`. Reads must be deterministic: the same range always returns the same records.
- **BatchLog** (per partition): `writePlan(plan)`, `lastPlan()`, `commit(id, endOffset)`, `lastCommit()`, plus `epoch` and `bumpEpoch()` on restart.
- **DedupStore** (per partition): `get(messageId)`, `putIfAbsent(messageId, entry)` and `expire(now)`.
- **Ledger** (the sink): `casApply(key, delta, id)` applies the delta only if `row.lastApplied < id` and returns `applied | rejected`. Each call is atomic for one row.
- **DropLog:** an append-only record of past-retention events.

### Runtime pieces

- **Producer:** appends a seeded workload (duplicates, late arrivals, rare past-retention events).
- **Worker:** one per partition. Runs the batch protocol and can be crashed at any named point.
- **Platform:** a supervisor that restarts a crashed worker after a delay (default 5–30 seconds of sim time).
- **Scheduler:** seeded discrete-event loop that interleaves workers and the producer.
- **Oracle:** computes the expected ledger directly from the events, with no pipeline involved.

## Batch protocol

Exactly-once means at-least-once plus idempotency. Every step is safe to repeat, the plan is written first and the commit is written last. Each worker runs this loop for its partition. C1–C4 are the named crash points between steps, and C2a and C3a are crash points halfway through a step's writes.

1. **Plan.** `writePlan({id: {epoch, idx: lastIdx + 1}, startOffset: committedEnd + 1, endOffset: min(logEnd, start + maxBatch − 1)})`. The batch range is now fixed forever. → **C1**
2. **Read** exactly `[startOffset, endOffset]`, never "whatever is available now".
3. **Filter**, in log order:
    - If `appendedAt − sentAt > 30 days`, append to the DropLog and skip.
    - If the dedup entry exists and `entry.id < current id`, it's a true duplicate: skip.
    - If the dedup entry exists and `entry.id == current id`, it's our own earlier attempt at this batch: keep it.
    - If messageId was already kept earlier in this batch (in-memory set), it's a duplicate within the batch: skip.
4. **Write dedup** entries with `putIfAbsent(messageId, {id: current id})` for each kept item. → **C2** (also **C2a**, crash after half of the writes)
5. **Aggregate** kept items into deltas per SinkKey, a pure function.
6. **Sink:** `casApply(key, delta, current id)` for each key in sorted key order. → **C3** (also **C3a**, crash after half of the rows)
7. **Commit** `(current id, endOffset)`. → **C4** (crash after the commit, before the next plan)

**Recovery** (on restart, `bumpEpoch()` first):

- If `lastPlan.id > lastCommit.id`, replay that exact plan, keeping its original BatchId. A replay is never re-stamped with the new epoch.
- Otherwise, plan the next batch, using the new epoch and idx + 1.

### Rules that make replay safe

- **Deterministic input:** the plan fixes the range, and the log returns the same records.
- **Deterministic decisions:** nothing inside a batch reads the processing clock. Every time-based decision (retention, bucket) uses record fields (appendedAt, sentAt, deliveredAt), so a replay hours later decides exactly the same way.
- **Partial writes are fine:** a crash halfway through dedup or sink writes needs no rollback. Replay reprocesses the batch, and the per-row CAS skips rows already applied.
- **Dedup and sink order is interchangeable.** Both are idempotent under the rules above. Only plan first and commit last are load-bearing. (This is a test case, not just a claim.)

### Invariants (asserted after every step in tests)

- **I1** For every sink row, `lastApplied ≤` the partition's last plan id.
- **I2** Once all partitions are drained, ledger == oracle for every (account, sku, halfHour) summed across partitions, and DropLog == the oracle's drops.
- **I3** No dedup entry has an id greater than the last plan id.
- **I4** The committed offset never goes backwards.

## Break-it toggles

Each toggle removes exactly one safeguard. The demo and the crash test both prove that each removal causes a specific billing error. The engine reads them from a `Safeguards` config object, all on by default; they are not scattered `if (demo)` checks.

| Toggle (safeguard off) | Exposed by | Result | What it teaches |
| --- | --- | --- | --- |
| `atMostOnce`: commit before processing | Crash at C1–C3a | Under-billed. The batch is skipped on restart (at C3 every sink row is already written, so nothing is lost) | Why committing before processing loses revenue |
| `noDedupStore`: no dedup, every copy is billed | No crash needed. Any multi-device duplicate | Over-billed | Replay idempotency (CAS) doesn't cover duplicates in the source data |
| `dedupIgnoresBatchId`: any existing key counts as a duplicate | Crash at C2 or C3a | Under-billed. The replay dedupes its own earlier attempt | Why a dedup entry carries a BatchId |
| `nondeterministicBatches`: no plan; on recovery, read whatever is available up to a random size | Crash at C2 | Under-billed. The replay reads fewer records, and the next batch falsely dedupes the rest | Why the plan is written before reading |
| `atLeastOnce`: add the delta without a CAS check | Crash at C3 or C3a | Over-billed. The replay keeps its own items and adds them again | Why the sink write must be conditional |
| `restampReplay`: replay uses the new epoch | Crash at C2 or C3a | Under-billed. Entries from the first attempt now look older than the replay, so they're treated as duplicates | Why a replay keeps its planned BatchId |

`restampReplay` is a stretch goal (`processingClock` was cut: retention uses only record fields, so the toggle was a strawman). Each guided scenario in the UI pairs one toggle with the crash point that exposes it, so the reviewer sees the failure on the first try.

## Simulation and verification

The whole run is a pure function of (seed, config, safeguards). Any failure the crash test finds becomes a one-click replay in the UI.

### Scheduler

- A discrete-event priority queue on a sim clock (ms). It uses a seeded PRNG (mulberry32 or similar), with no `Math.random` or `Date.now` anywhere in the engine.
- The producer and the workers are actors. Each pipeline step is a single event, so a crash can land between any two steps.
- Crash injection comes in two forms: (a) a scripted crash ("partition 3, batch 2, at C2"), used by the UI buttons and guided scenarios; (b) random crashes with probability p at each crash point, used by the crash test.
- A crash discards the Worker object. Platform schedules a restart after a seeded delay. The restarted worker calls `bumpEpoch()` and runs recovery.

### Workload generator (defaults are adjustable)

- About 20 accounts × 3 SKUs, with prices from a fixed table per SKU.
- About 5,000 unique messages over 2 sim-hours of append time, with deliveredAt spread across those hours.
- Duplicates: 15% of messages are delivered to 2–3 devices; 3% get an infra retry. Copies are spread across different appended positions, so some land in the same batch and some in later ones.
- Late events: 5% have deliveredAt 1–29 days before appendedAt, from phones coming online late, so they land in old buckets.
- Past retention: 0.3% have sentAt more than 30 days before appendedAt. These go to the DropLog.
- For the demo, the sim compresses "days" by setting timestamps directly, not by running the clock for days. TTL expiry is checked by a `now` comparison.

### Oracle (independent of the engine, about 30 lines)

- Drop events past retention, keep the first copy of each messageId in log order, and sum priceMicros by (account, sku, halfHour).
- Never import engine code into the oracle. It must be able to disagree with the engine.

### Crash test (`npm run crash-test -- --seeds 2000 --p 0.05`)

- For each seed: generate the workload, run with random crashes until every partition is drained, then assert I1–I4 after each step and I2 at the end.
- Safeguards all on: 0 failures expected. Print seeds/second and the total number of crashes injected (expect thousands).
- Each break-it toggle on its own: the test must fail. Report the % of seeds that failed, total over- and under-billed micros, and the first failing seed with its crash trace. If a toggle never fails, the test or the toggle is wrong.
- Output a markdown table (toggle × failed seeds × ±$) to `results/crash-test.md`. That table goes straight into the written rationale and the UI.

**Unit tests (vitest):** one targeted test per crash point and per toggle. Also a test that swaps the order of the dedup and sink steps and still passes, and a test that replays one batch five times in a row and still passes.

## Demo UI

The UI has one screen with guided scenarios. A reviewer who clicks nothing but Next scenario still sees every idea. The free-play controls are there for reviewers who want to dig.

Layout, top to bottom:

- **Header bar:** scenario picker, seed, play/pause/step, speed, and a big status pill: Ledger matches oracle (green) or Over-billed $X / Under-billed $Y (red).
- **Partition lanes (8 rows):** a log bar showing committed, planned and log-end offsets; the worker state (running / crashed / restarting in Ns) and its epoch; and the current batch id.
- **Pipeline strip** for the selected partition: the 7 steps as boxes, with a ⚡ button in each gap (C1–C4, C2a, C3a). Clicking ⚡ arms a crash for the next time the worker reaches that point. The active step is highlighted, and a replay is labeled as one.
- **Ledger panel:** rows of account × sku × half-hour, showing the engine total, the oracle total and the difference. Rows touched by late events get a "late" badge. The table can be filtered to only mismatched rows.
- **Safeguards panel:** the 6 toggles, each with a one-line description. A toggle that's off turns its label red.
- **Event inspector,** opened by clicking a messageId: all of its copies (device, offset, batch), its dedup entry, the sink row it billed, or why it was skipped or dropped.
- **Narration log:** plain-English lines, e.g. "P3 crashed at C2 during batch (2,7). Restarted as epoch 3. Replaying (2,7) from offsets 300–399."

Guided scenarios (each pins a seed, armed crashes and toggles):

1. **Normal day:** duplicates and late events, no crashes. All green, and late events land in old buckets.
2. **At-most-once:** crash at C3a (halfway through the sink writes). Green with safeguards on. Flip atMostOnce. Red, under-billed.
3. **Crash after dedup, before sink:** safeguards on, crash at C2. Green. Then flip dedupIgnoresBatchId and replay. Red, under-billed.
4. **The shrinking replay:** nondeterministicBatches, crash at C2. Red. The inspector shows the next batch falsely deduping.
5. **At-least-once, crash after sink, before commit:** crash at C3. Green because the CAS rejects the second write. Flip atLeastOnce. Red, over-billed.
6. **The phone that came back:** one message delivered 3 weeks late lands in its old bucket and is billed. A different message, sent more than 30 days before it was appended, lands in the DropLog.
7. **Sandbox:** free play on the same seed; the only scenario where safeguards and crash points are editable (guided scenarios show theirs read-only).
8. **Crash test:** runs 500 seeds in a Web Worker with a progress bar, then shows the toggle × failures table.

**Visual tone:** calm and dense, like an engineering console. Use monospace for ids and offsets, and keep red and green for correctness only.

## Repo layout, stack and deployment

The stack is TypeScript end to end: a dependency-free engine package, a Vite + React app and a Node CLI. Everything deploys as a static site with no backend.

> The layout block in the source doc was partly cut off. The tree below is reconstructed from the rest of the plan; the last three entries are verbatim.

```
packages/engine/        # dependency-free engine: types, stores, worker, scheduler, workload, invariants
packages/oracle/        # independent oracle; must not import @eob/engine
apps/crash-test/           # Node crash-test CLI
results/crash-test.md
apps/web/               # Vite + React UI; the crash test runs in a Web Worker
docs/RATIONALE.md       # written design doc for submission
```

- **Tooling:** pnpm workspaces, TypeScript strict mode, vitest, and ESLint with a rule banning `Math.random` and `Date.now` in `packages/engine`.
- **UI libraries:** plain React with CSS modules or Tailwind. Skip chart libraries, since the lanes and tables are simple SVG and DOM.
- **Determinism check in CI:** run the same seed twice and require byte-identical event traces.
- **Deploy:** Vercel or Cloudflare Pages from `apps/web`, or GitHub Pages through an Action. A GitHub Action runs tests plus `crash-test --seeds 200` on every push. The README shows a CI badge and the crash-test results table.

## Build milestones

The build is six milestones totaling about 6 hours. The cut line is after M3: if time runs short, ship the engine, the crash-test results and a minimal UI (scenario picker, ledger diff, crash buttons) rather than a polished UI with no proof behind it.

| # | Milestone | Budget | Done when |
| --- | --- | --- | --- |
| M0 | Scaffold the repo, tooling and CI; add PLAN.md | 15 min | `pnpm test` runs green on an empty suite |
| M1 | Types, in-memory stores, the worker protocol, recovery and crash points | 90 min | Unit tests pass for every crash point with safeguards on |
| M2 | Seeded scheduler, Platform restarts, workload generator, oracle and invariants | 60 min | The same seed gives an identical trace twice; ledger == oracle with no crashes |
| M3 | Safeguard toggles and the crash-test CLI | 45 min | All on: 0 failures across 2,000 seeds. Every toggle: fails |
| M4 | Web UI: lanes, pipeline strip, ledger diff, toggles, guided scenarios, crash test in a Web Worker | 120 min | All guided scenarios behave as described in Demo UI |
| M5 | Deploy, README, RATIONALE.md, record the video | 45 min | The public URL works in a fresh incognito window |

Prompts for Claude Code (start each in plan mode and review the plan before accepting):

- **M1:** "Read PLAN.md. Implement packages/engine types, store interfaces and in-memory stores, and the worker batch protocol exactly as in Batch protocol, with named crash points that throw a CrashSignal. Write the vitest cases for each crash point first, then the code. No randomness or wall clock in the engine."
- **M2:** "Add the seeded scheduler, Platform restarts with epoch bump, the workload generator with the defaults in PLAN.md, the oracle (it must not import worker code) and invariants I1–I4. Add a determinism test."
- **M3:** "Add the Safeguards config and implement each toggle as a minimal deviation in the worker. Build the crash-test CLI. Each toggle must fail at least one seed; if one doesn't, tell me why before changing anything."
- **M4:** "Build apps/web per the Demo UI section. Start with the ledger diff and the pipeline strip, then the lanes, then the guided scenarios."

Judgment checkpoints to keep in the transcript (this is what the reviewers grade):

- Reject any suggestion to add Kafka, Flink or a backend.
- Check that the oracle is truly independent of the engine.
- Confirm that every toggle actually fails the crash test.
- Read the replay code path line by line yourself.

## Out of scope

These are deliberately out of scope. Each one becomes a paragraph under "With more time" in the rationale.

- **Rebalancing and zombie fencing.** We use static assignment plus restart. With rebalancing, the epoch would become a fencing token checked on every sink CAS.
- **Repartitioning.** Drain, then a full reshard of the dedup state (hash by the new P).
- **Late events after an invoice is issued.** Post them as adjustment lines on the next invoice rather than mutating a closed bucket.
- **Real infrastructure.** A SQLite-backed store with kill -9 crash testing is the first stretch goal. Kafka and a database sink would come after that.
- **The send→delivery join.** Price lookup at send time, joined to delivery.

## Submission checklist

- [x] Public prototype URL (works in incognito, no login): https://q820.github.io/exactly-once-billing/
- [x] GitHub repo with README: one-paragraph pitch, how to run, crash-test results table: https://github.com/q820/exactly-once-billing
- [x] RATIONALE.md: theme choice, why this is non-obvious, the 4 rules, the decisions table, tradeoffs, learnings and iterations, extensions, time spent
- [ ] Video (~5 min): 30s story → scenarios 2, 3, 5 live → crash-test table → what's next
- [x] Claude transcripts: this planning chat plus the Claude Code session (`docs/transcripts/`)
