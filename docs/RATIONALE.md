# Rationale

## Theme and pitch

**Theme:** Systems & Reliability.

I ported a real at-most-once streaming billing pipeline (Scribe/Stylus at Meta, comparable to Kafka/Flink) to exactly-once. This prototype distills that protocol into a small engine you can crash between any two steps, in the browser, while an independent oracle checks every cent.

## Why this is non-obvious

Exactly-once is usually sold as a framework feature. It isn't one. The framework gives you at-least-once delivery and a place to keep state. Exactly-once comes from four rules in your own code, and each is cheap to get subtly wrong:

1. **Deterministic batch boundaries.** Write the batch's offset range (the plan) before reading anything. A replay reads exactly that range, never "whatever is available now".
2. **A dedup check that tells a replay from a duplicate.** Each dedup entry carries the BatchId that kept it. An entry from an older batch means a true duplicate; an entry from the current batch means our own earlier attempt, so keep the item.
3. **Compare-and-set sink writes keyed by BatchId.** A row applies a delta only if `lastApplied < batchId`, so a replay's second write is rejected per row and partial writes need no rollback.
4. **Commit last.** The commit is the only thing that tells recovery a batch is done.

Two supporting rules fall out of these: a replay keeps its planned BatchId even though the worker restarted with a new epoch, and every time-based decision inside a batch (retention, bucket) uses record fields, never the processing clock.

Late events are normal, not a failure mode: a phone that comes online three weeks later is billed into its three-week-old half-hour bucket through the same path as any other event.

## How it is proven

- **The engine** (`packages/engine`) is a step machine: one `step()` call is one protocol step, so the seeded discrete-event scheduler can land a crash between any two steps, and halfway through the dedup and sink writes (C2a, C3a). A crash throws away the Worker object; only the five stores survive. Lint bans `Math.random`, `Date.now`, `new Date()` and timers in the engine, so a whole run is a pure function of (seed, config, safeguards). A determinism test runs a seed twice and requires byte-identical traces.
- **The oracle** (`packages/oracle`, 50 lines) restates the billing rules from scratch: drop past-retention events, keep the first copy of each messageId in log order, sum by (account, sku, half-hour). It imports nothing, lint forbids it from importing the engine, and it reads the generated events, not the pipeline's source log. It can disagree with the engine, and a test tampers with the ledger to show it does.
- **Invariants** I1, I3 and I4 are checked on every store write (only writes can break them, so this equals "after every step" at O(1) cost). I2, ledger == oracle and DropLog == oracle drops, is checked once all partitions drain.
- **Unit tests** (128) are written against a hand-written 12-event fixture with expected totals as literals. They cover every crash point, five replays of one batch in a row, dedup and sink in swapped order, crashes in every batch, and one targeted test per toggle. Each toggle test shows the predicted error at the exposing crash point and correct billing at a crash point that doesn't expose it. A mutation check (re-introducing three of the toggled bugs by hand) failed 9 to 18 tests each.
- **The crash test** crashes every crash point with probability 0.05 over 2,000 seeds per configuration: 746,507 crashes with all safeguards on and 0 failed seeds. The table is in the [README](../README.md) and [results/crash-test.md](../results/crash-test.md).

## Locked decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Event types | Delivery events only; price fixed at send and carried on the event | Pricing on send, billing on delivery. The send→delivery join doubles the state work without a new idea |
| Sources of duplicates | Multi-device delivery plus infra retries | Both share a messageId, so one dedup key covers both |
| Framework | Own micro-batch engine in TypeScript, no Kafka or Flink | The contribution is the protocol. Closest real-world model: Spark Structured Streaming (offset log plus batchId-idempotent sinks) |
| Partitioning | Fixed P (8), partition = hash(messageId) % P | All copies land on one partition, so dedup is partition-local |
| Worker failure | Static assignment; a dead worker's partition lags until the Platform restarts it | Billing tolerates delay, not error. No rebalancing means no zombie writers |
| Dedup retention | 30-day TTL | Delivery is promised within 30 days. One number for both rules keeps it simple |
| Past retention | appendedAt − sentAt > 30 days: log to the DropLog, never bill | Billing it risks a double-bill; a surprise line next month confuses businesses |
| Sink key | account × sku × half-hour(deliveredAt) × partition; invoices sum across partitions | One writer per row |
| Money | Integer micros | Exact totals |

## Decisions made while building

- **Dedup entries expire after each commit against the batch's largest appendedAt, not the processing clock.** appendedAt is non-decreasing in log order and all copies share sentAt, so any copy arriving after its entry expired is already more than 30 days past its send and is dropped as past-retention. Expiring only after the commit means a replay never sees fewer entries than its first attempt did. A unit test pins this.
- **The DropLog is idempotent per (partition, offset).** A replay re-runs the filter; an append-only DropLog would record a drop twice and break I2.
- **The oracle is its own package** with a lint rule against importing the engine, so independence is enforced rather than promised.
- **Each toggle is one guarded line in the worker** (`if (!this.sg.casSink) …`), read from a `Safeguards` object.
- **The `processingClock` toggle was cut, and retention is 30 days everywhere.** The retention check uses only record fields (`appendedAt − sentAt`), and lint bans clocks in the engine, so a toggle that reads the processing clock was a strawman nobody would write in this design (it also couldn't fail on a realistic workload). The 5-day dedup margin was dropped for the same reason: one 30-day number for the dedup TTL and the drop rule. The drop threshold only has to be no larger than the dedup TTL.

## Findings that correct the plan

These came out of the toggle tests and the crash-test run, and are not yet folded back into PLAN.md:

- **`commitFirst` is exposed by C1 through C3a, not C1 through C3.** At C3 every sink row is already written, so committing early loses nothing. The legacy-pipeline scenario crashes at C3a instead.
- **`restampReplay` and `dedupIgnoresBatchId` produce identical results with dedup before sink:** in both, the replay mistakes its own first-attempt entries for duplicates. They differ when the sink runs first: the re-stamped id beats the row's CAS, so `restampReplay` over-bills where `dedupIgnoresBatchId` stays correct. A test pins the difference.
- **`commitFirst` over-bills a few rows ($0.24 over 2,000 seeds) while under-billing $16,778.** When a skipped batch loses a message's first copy, a later copy from another device can land in the next half-hour bucket and be billed there.

## Tradeoffs

- **In-memory stores** keep the demo in a browser tab. The engine depends only on the store interfaces, so a SQLite store is a drop-in.
- **Small demo batches.** The UI uses 1,500 messages, maxBatch 20 and a 5-minute poll so batches hold about 9 records and the crash points are watchable; the crash-test CLI uses the full PLAN defaults.
- **Crash probability 0.05 per crash point** means every seed sees hundreds of crashes, so every toggle fails 100% of seeds. That proves each removal breaks billing; it says little about how rare each failure is. A lower p would give a rate per toggle.

## With more time

- **Rebalancing and zombie fencing.** We use static assignment plus restart. With rebalancing, the epoch becomes a fencing token checked on every sink CAS, so a zombie worker from an old epoch can't write.
- **Repartitioning.** Drain, then a full reshard of the dedup state, hashing by the new P.
- **Late events after an invoice is issued.** Post them as adjustment lines on the next invoice rather than mutating a closed bucket.
- **Real infrastructure.** A SQLite-backed store with `kill -9` crash testing is the first stretch goal; Kafka and a database sink after that.
- **The send→delivery join.** Price lookup at send time, joined to delivery.

## Time spent

<!-- Fill in: planning chat, M0-M5 build time. -->
