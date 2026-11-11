# Exactly-Once Delivery Billing

[![CI](https://github.com/q820/exactly-once-billing/actions/workflows/ci.yml/badge.svg)](https://github.com/q820/exactly-once-billing/actions/workflows/ci.yml)

**Live demo: https://q820.github.io/exactly-once-billing/**

A browser-playable simulation of an exactly-once billing pipeline for message deliveries that you can crash between any two steps. Exactly-once doesn't come from the framework: it comes from four small rules (deterministic batch boundaries, a dedup check that tells a replay from a duplicate, compare-and-set sink writes keyed by batch id, and committing last). Each rule has a toggle. A Node crash test crashes the pipeline hundreds of thousands of times and checks the ledger against an independently computed oracle: with every safeguard on it never over- or under-bills, and turning one off produces a specific, visible billing error.

Design: [docs/RATIONALE.md](docs/RATIONALE.md). Plan: [PLAN.md](PLAN.md). AI transcripts: [planning chat (claude.ai)](docs/transcripts/planning-chat.md) and [build session (Claude Code)](docs/transcripts/claude-code-session.md).

## Run

Requires Node 24 and pnpm 10.

```sh
pnpm install
pnpm dev                                  # the demo UI at http://127.0.0.1:5180
pnpm check                                # typecheck + lint + 132 tests
pnpm crash-test -- --seeds 2000 --p 0.05     # writes results/crash-test.md and .json
pnpm build                                # static site in apps/web/dist
```

`pnpm crash-test` options: `--seeds N`, `--p <crash probability>`, `--only <config,...>`, `--skip <config,...>`, `--threads N`, `--messages N`.

## Crash test results

2,000 seeds per config, default workload (5,000 messages over 2 sim-hours, 8 partitions), at two crash rates per crash point:

- **p = 0.05:** a few hundred crashes per seed. Shows each toggle always breaks billing under heavy crashing. Full output: [results/crash-test.md](results/crash-test.md).
- **p = 0.001:** about 6 crashes per seed. Shows how often each bug bites under realistic crashing. Full output: [results/crash-test-p0.001.md](results/crash-test-p0.001.md).

| Config | Failed seeds, p=0.05 | Over / under, p=0.05 | Failed seeds, p=0.001 | Over / under, p=0.001 |
| --- | ---: | ---: | ---: | ---: |
| all safeguards on | **0 / 2000** (746,507 crashes) | $0.00 / $0.00 | **0 / 2000** (12,274 crashes) | $0.00 / $0.00 |
| `nondeterministicBatches` (rule 1) | 2000 / 2000 | $0.00 / $489.88 | 426 / 2000 (21%) | $0.00 / $9.36 |
| `dedupIgnoresBatchId` (rule 2) | 2000 / 2000 | $0.00 / $10,547.52 | 1883 / 2000 (94%) | $0.00 / $216.75 |
| `atLeastOnce` (rule 3) | 2000 / 2000 | $8,386.32 / $0.00 | 1707 / 2000 (85%) | $153.85 / $0.00 |
| `atMostOnce` (rule 4) | 2000 / 2000 | $0.00 / $3,036.09 | 1219 / 2000 (61%) | $0.00 / $59.12 |

Each toggle turns off one of the four rules. `nondeterministicBatches` fails least often because it needs a crash and a replay whose re-picked range comes out shorter.

## Layout

```
packages/engine/   dependency-free engine: types, stores, worker, scheduler, workload, invariants
packages/oracle/   independent oracle (lint forbids importing the engine)
apps/crash-test/      seed runner, ledger-vs-oracle check, crash-test CLI
apps/web/          Vite + React demo; the crash test runs in Web Worker
results/           crash-test output
docs/RATIONALE.md  design write-up
docs/transcripts/  planning chat and Claude Code session
```

## Deploy

`.github/workflows/pages.yml` builds `apps/web` and publishes it to GitHub Pages on every push to `main` (enable Pages with source "GitHub Actions" in the repo settings). The build is a static site with relative paths, so Vercel or Cloudflare Pages work too: build command `pnpm build`, output `apps/web/dist`.
