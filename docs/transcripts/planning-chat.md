# Planning Transcript: Claude.ai (Theme 3: Systems & Reliability)

**Session:** Claude.ai chat with Claude Opus 5.5, Wed Nov 4, 2026 (America/Los_Angeles)
**Purpose:** choose the project, settle the design, and write the build plan that was then carried out in Claude Code.
**Output:** the "Exactly-Once Delivery Billing — Build Plan" doc (exported to the repo as `PLAN.md`).

> Edits to this transcript: the recruiter's emails in the first message are summarized in one line (they include a personal Claude Max promo code), and the recruiter's name is replaced with "the recruiter" throughout. Tool calls (reading the PDF, writing the doc) are summarized in brackets. Everything else is as exchanged.

---

## Time spent

| Time (PT) | Elapsed | Phase |
| --- | --- | --- |
| 9:36 | — | Shared the assignment; Claude summarized the requirements |
| 9:58 | 22 min | Picked Theme 3; brainstormed four directions |
| 10:16 | 18 min | Brought in the Meta exactly-once billing design; asked which framework to presume |
| 10:29 | 13 min | Narrowed scope: delivery events only, 35-day retention |
| 10:34 | 5 min | Corrected dedup/TTL/drop rules, added SKU to the sink key, asked about partitioning |
| 11:09 | 35 min | Chose a fixed partition count with static assignment and restart (no rebalancing) |
| ~11:20 | ~11 min | Build plan doc finished |

**Total: about 1 h 45 min** of design and planning, from the first message to the finished plan.

**My decisions in this session** (as opposed to Claude's suggestions):
- Rejected Claude's first suggestion (a generic "metastable failure lab") in favor of a project grounded in my own production experience: porting Meta's at-most-once Scribe/Stylus billing pipeline to exactly-once.
- Supplied the core protocol: `(epoch, batch_idx)` tagging on dedup entries, the ordering of commit vs. state store vs. sink, CAS upserts on the sink, and deterministic batch reads.
- Cut the send→delivery join to stay within the time box.
- Overrode Claude's proposed TTL-clock and quarantine logic: a flat 35-day TTL (tied to WhatsApp's 30-day delivery promise), with past-retention events logged and dropped.
- Added the product SKU to the sink key.
- Chose static partition assignment with platform restart over rebalancing, which removed the zombie-writer scope Claude had proposed.

---

## Transcript

### User — 9:36

*[Attached: `SWE_take-home_assignment_5.pdf`]*

> *[Pasted the recruiter's assignment email and a follow-up asking for a submission date. Trimmed here: the email restates the assignment (build a hosted prototype on one of the themes; submit a live link, GitHub repo, ~5-minute video, short written doc and AI transcripts; 2 weeks), plus a Claude Max coupon.]*

### Claude

*[Read the assignment PDF.]*

I read the assignment. Here's what matters most:

- **The time limit is short.** The target is 1–2 hours and the hard cap is 8. Scoping is part of what they grade, so one deep idea is better than several features.
- **There are five themes, not three.** The PDF adds Evaluation & Data Quality and Performance Optimization to the three in the recruiter's email. Performance is graded mostly on measured benchmarks against a baseline.
- **Your judgment is what's being evaluated.** They want your AI transcripts and say a fully AI-generated project with no judgment won't pass. If we build it together here, this chat becomes part of what you submit, so you should be the one choosing the idea, pushing back on my suggestions and making the tradeoffs.
- **Reviewers must be able to use it without supplying anything.** Include demo data or a demo mode, and put it at a hosted link.
- **There are four things to submit:** a live prototype link, a GitHub repo, a ~5-minute video plus a short written doc (include roughly how long you spent), and your transcripts.

Since the recruiter is asking when to expect your submission, it's worth replying soon with a date you can meet.

Where do you want to start? I can help you choose a theme and scope an idea based on your interests and strengths, start building once you've picked one, or draft a short reply to the recruiter with a submission date.

---

### User — 9:58

> Let's focus this conversation on system and reliability project. Approach: we will first brainstorm decide on what we want to deliver and how (what's simulated/what's real) , build a well detailed plan, then I'll go to Claude code and execute that plan.

### Claude

Here are four directions. For each one, the most important question is which parts run for real and which are simulated.

**1. Metastable failure lab (my top pick).** A short spike, like a GC pause or traffic burst, can cause retries that keep the system overloaded long after the spike ends. The tool would show that happening: you trigger a spike and watch goodput collapse and stay down. Then you turn on mitigations (jittered backoff, retry budgets, circuit breakers, load shedding, adaptive concurrency limits) and replay the same seed to see which ones recover.
- **Real:** the mitigation algorithms, written as a small tested library.
- **Simulated:** the clients, servers and clock, using a deterministic discrete-event simulation that runs in the browser.
- **Why it's non-obvious:** most demos show how failures start. This one shows why a system stays broken, which is a real and under-explained problem. It also maps directly to LLM serving, where overloaded errors trigger client retries.

**2. Resilient LLM client and proxy.** A proxy in front of a model API handling 429/529 errors, timeouts, request hedging, fallback models, and resuming a stream that drops mid-response. A chaos panel injects failures.
- **Real:** the proxy.
- **Simulated:** a fake upstream, so reviewers don't need an API key.
- **Tradeoff:** very practical, but harder to make visually compelling, and resuming streams is fiddly.

**3. Durable job queue under chaos.** Leases, idempotency keys and SQLite persistence, with a UI where you kill workers or partition them and check that no job is lost or run twice.
- **Real:** everything.
- **Tradeoff:** solid, but a common choice and less distinctive.

**4. Deterministic simulation testing harness.** FoundationDB-style: run a small replicated key-value store under a seeded simulator that injects faults, finds a bug and gives you a seed that replays it exactly.
- **Tradeoff:** the most impressive engineering, but the riskiest to finish in a few hours.

**My recommendation:** #1, possibly borrowing one idea from #4. If the mitigation code doesn't know whether its clock is real or simulated, you can say "the same code runs in the sim and would run in prod," which makes it a real systems project and not just a visualization. It also hosts as a static site, so there's nothing to deploy or break.

Which direction appeals to you, and what stack are you strongest in (TypeScript/React, Python, Go…)? Once you pick, I'll write the detailed plan for you to take into Claude Code.

---

### User — 10:16

> i was thinking of showcasing my experience a bit: i work in Pricing team of Meta's business messaging. Pricing on send, Billing on delivery. (late events must be supported). the streaming system used at meta with Scribe (Kafka equivalent) and Stylus (Flink equivalent) was at most once and i've ported it to exactly once in the past few months.
>
> the degradation here can be:
>
> * crashes (and how our design promises to not over or under bill)
> * i'd say late events, but that's a part of design (user phones can turn on later).
>
> key elements (unsure which ones need to be ported to kafka/flink or other technologies of choice):
>
> * going the route of a KV store of duplicate: late events can be deduped this way; but now we'd be questioning the utility of Flink's window
> * writing outputs aggregated by paymentAccount.halfhour_of_day (cache this -> rocksdb -> read from output source; avoid reading when another writer is writting by preventing in flight repartitionining; can drain first and then full repartition if needed)
> * use (epoch, batch_idx) as we write dedup store events. read data only when curr_batch_idx > read_item_batch_idx (so on crash, idx is equal, and we dont falsely deduplicate)
> * control over the order of operations: "checkpoint commit" against "save to state store" against "write to output/sink". to ensure exactly once: at least once (so commit comes last basically) + idempotency (achieved by saving to state store with batch idx AND achieved in output:database by doing transactional CAS style upsert)
> * this then requires determininstic queue reads: i.e. after a crash, i read the same batch again (as opposed to reading fewer items on reprocessing, and the batch after will falsely get deduped)
>
> way more details to cover, but let's build on top of this. the difficulty comes here that: we need to simulate, so we have to _presume_ a framework, but depending on what we presume, that might change the level of work. what options other than flink for the purposes of this demo do we have that we can showcase/dleiver on crash resiliency, exactly once and _late deliveries_.

### Claude

Don't presume Flink. Presume the smallest model your protocol needs, and build that model yourself. Your contribution is the protocol: the order of operations, the batch indexes and the deterministic replay. None of it depends on Flink. What you're describing is a **micro-batch** model, the same shape as Spark Structured Streaming, which records each batch's offset range before processing it and gives sinks a `batchId` so writes can be idempotent. You've in effect built that on top of an at-most-once Scribe/Stylus stack. That framing is a strong story in itself.

**The options:**

- **Real Kafka + Flink.** Credible, but heavy to host, slow to crash on demand, and Flink's own exactly-once (checkpoint barriers + two-phase-commit sinks) is a different design from yours. You'd spend the 8 hours on infrastructure.
- **Real Kafka (Redpanda) + your own consumer + Postgres.** Real parts you can `kill -9`, but it needs a hosted VM, and reviewers would ask why you aren't using Kafka transactions.
- **Embedded engine you build (recommended).** Four small parts: a replayable log with offsets, a durable batch/offset log, a key-value dedup store and a ledger sink with compare-and-set upserts. It runs in one process with real SQLite, or in the browser. Every step boundary is a named crash point.

**Why the embedded engine makes the best demo:**
- **Crash anywhere.** The reviewer clicks a crash point (after the state write, after the sink write, before commit) and watches the replay. The ledger still matches an "oracle" ledger computed separately.
- **Break-it toggles.** Each one turns off one of your safeguards and shows the exact failure it prevents:
  - no batch-index check → false dedup on replay → under-billing
  - non-deterministic batch boundaries → the next batch falsely dedupes → under-billing
  - commit before sink → lost writes
  - no compare-and-set → double-billing
- **The real-process proof.** The same engine runs headless while a script kills it at random points thousands of times, then asserts ledger == oracle. That's the part that makes it real engineering and not just an animation.

**On your Flink-window question:** you're right that you don't need windows for correctness. Dedup plus a keyed upsert into `paymentAccount × half-hour` (by event time) lets a late event update an old bucket. Windows and watermarks only decide when a bucket is *final*. That leads to a good tradeoff knob: **dedup retention vs. maximum lateness.** If a duplicate arrives after its dedup key has expired, you double-bill. A slider for retention, plus a "phone comes online 3 days later" event, shows that directly. Optionally, buckets past an invoice cutoff could receive adjustment lines and not get mutated in place, which is very true to billing.

Two questions before I write the plan:
1. **Stack:** TypeScript in the browser (static hosting, nothing to keep alive), or Python/Go with a small web UI?
2. **Scope:** model only delivery events, each carrying its price, or also the send→delivery join (price fixed at send, billed on delivery)? The join is more authentic, but it roughly doubles the state-management work.

---

### User — 10:29

> although 2 is real, we already have the complexity around late events and crash resilience. stick to delivery events only.dedup retention is 35 days. it'll depend on each product's promises i guess, but in Whatsapp we commit to sending the msg in 30 day window and we want businesses to trust us so we commit to never double bill in that time window.

### Claude

Good, 35-day retention against a 30-day delivery promise gives a 5-day safety margin. That's worth stating explicitly in your written doc. Two more decisions follow from it, and I'd lock them in as defaults:

- **TTL clock:** measure dedup expiry from the message's **send time** (send + 35 days), not from when the key was first stored. A duplicate delivery can arrive at most 30 days after send, so this ties retention directly to the product promise.
- **Events past the retention window:** route them to a **quarantine/dead-letter table** and never bill them. Once the dedup key may be gone, billing would risk breaking the no-double-billing promise, so the engine refuses. The demo can include one "impossible" event (delivered 40 days after send) to show this.
- **Bucket by delivery time:** late events land in old `paymentAccount × half-hour` buckets through the same compare-and-set upsert, with no special path for them.

I still need your stack choice before writing the plan:

- **TypeScript only (my default):** the engine is a plain TS library run two ways, in the browser for the interactive demo and in Node for the kill-it-thousands-of-times proof. The demo hosts as a static site.
- **Python/Go engine + web UI:** closer to "real backend" code, but it needs a hosted server and two codebases.

Say which, or "go with TS," and I'll write the full plan as a doc you can hand straight to Claude Code.

---

### User — 10:34

> let's focus only on one type of event: delivery. the duplicate events want to cover the same message getting delivered to multiple devices, or infra failures. the 35 is simply a ttl on the dedup state store. ttl clock is neglijable in the face of 35 days. invoicing happens monthly, events past retention are minimal and might create more confusion for the business in the next invoice so keep it simple for now and we just log and drop them.
>
> output db bucket key can contain product sku as well.
>
> how are we going envisioning this simulated engine with partitions/shards?

### Claude

Noted: dedup covers multi-device and infra duplicates, TTL is a flat 35 days, events past retention are logged and dropped, and the sink key becomes `paymentAccount × sku × half-hour`.

Here's how I'd shard the simulated engine:

**1. Partition the log by `message_id`, not by account.** All duplicates of a message (multi-device or infra retries) then land on the same partition. Each partition's dedup store only needs to be local, so you never need a cross-partition dedup lookup. Use a fixed count (say 4) for the demo.

**2. Each partition is a task that owns its own state:**
- an offset/batch log
- a dedup shard: `message_id → (epoch, batch_idx)`, TTL 35 days
- an ownership **epoch**

A small pool of workers (say 2–3) runs these tasks. Killing a worker moves its partitions to another worker, which bumps the epoch. A real Kafka consumer-group rebalance works the same way.

**3. Write one sink row per partition, and sum the rows when you read.** Several partitions hit the same `account × sku × half-hour` bucket, so a single shared row would need read-modify-write across writers. That's the contention you described avoiding at Meta. Instead, key rows as `(account, sku, halfhour, partition)`, each storing a running total plus its last applied `(epoch, batch_idx)`. Each row then has exactly one writer. The compare-and-set accepts a write only if its `(epoch, batch_idx)` is newer than the stored one. Invoices and the oracle check read the sum across partitions.

**4. The epoch fences zombie writers.** A worker that was paused, still thinks it owns a partition and wakes up writes with a stale epoch, so the compare-and-set rejects it. That's one more failure mode for the demo, and your `(epoch, batch_idx)` pair already covers it.

**5. Each batch runs these steps in order, and every gap between steps is a crash point:**
1. Write the batch plan `(partition, epoch, batch_idx, start_offset, end_offset)`. This is what makes replay deterministic.
2. Read exactly that offset range.
3. Dedup: skip an item if it's already stored with a `batch_idx` lower than the current one. An item stored with the same index is a replay, not a duplicate.
4. Write the dedup entries tagged with the current `(epoch, batch_idx)`.
5. Aggregate the batch into per-bucket deltas.
6. Do the compare-and-set upsert on each sink row.
7. Commit the offset.

On recovery: if the last plan has no commit, replay exactly that range; otherwise plan the next batch.

**6. How "real" it is.** Workers are logical actors interleaved by a seeded scheduler on a simulated clock. A crash discards the worker's in-memory state, and the durable stores survive. The durable stores sit behind interfaces, so the same engine code later runs on SQLite under a real `kill -9`, which I'd list as a stretch goal. For the core proof, a Node script runs thousands of seeds with random crashes and checks the ledger against the oracle every time.

**7. Repartitioning (changing the partition count) is out of scope.** I'd write it up as "drain, then full reshard," matching your approach. Rebalancing within a fixed partition count is in scope, because that's where the epochs pay off.

One question: do you want the zombie-worker scenario in the core demo, or should it stay a stretch goal? It's about two hours of extra work but a strong systems point. Once you answer, I'll write the full plan doc.

---

### User — 11:09

> We're going with the design of choosing a large enough partition size , one worker died, wait for platform to restart it.

### Claude

Got it: a fixed, generously sized partition count and static assignment. A dead worker's partitions just lag until the platform restarts it, and then it resumes from its own batch log. There's no rebalancing, so there are no zombie-writer scenarios. I'll write the full plan as a doc now, using TypeScript.

*[Created the doc "Exactly-Once Delivery Billing — Build Plan" and filled it section by section: Goal and pitch · Locked design decisions · Architecture (data model, store interfaces, architecture diagram) · Batch protocol (7 steps, crash points C1–C4/C2a/C3a, recovery, invariants I1–I4) · Break-it toggles · Simulation and verification · Demo UI · Repo layout, stack and deployment · Build milestones with Claude Code prompts · Out of scope and deliverables.]*

*[While writing, Claude corrected its own break-it table after re-checking the replay logic: `dedupIgnoresBatchId` is exposed at C2/C3a rather than C3, and `restampReplay` causes under-billing (its own dedup entries look like older duplicates), not over-billing. Claude also left a review comment asking the user to confirm that a replay keeps its original (epoch, batch_idx).]*

The [Exactly-Once Delivery Billing build plan] is ready for you to edit or comment on. I left one question on it: does a replay keep its original batch id? When you start in Claude Code, export the doc as Markdown and drop it into the repo as `PLAN.md`.
