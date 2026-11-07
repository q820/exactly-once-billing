# Exactly-Once Delivery Billing

<!-- CI badge: replace OWNER/REPO once the repo is on GitHub -->
<!-- ![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg) -->

A browser-playable simulation of an exactly-once billing pipeline for message deliveries that you can crash between any two steps. Exactly-once doesn't come from the framework: it comes from four small rules (deterministic batch boundaries, a dedup check that tells a replay from a duplicate, compare-and-set sink writes keyed by batch id, and committing last). Each rule has a toggle. A Node crash test crashes the pipeline hundreds of thousands of times and checks the ledger against an independently computed oracle: with every safeguard on it never over- or under-bills, and turning one off produces a specific, visible billing error.

Design: [docs/RATIONALE.md](docs/RATIONALE.md). Plan: [PLAN.md](PLAN.md).

## Run

Requires Node 24 and pnpm 10.

```sh
pnpm install
pnpm dev                                  # the demo UI at http://localhost:5173
pnpm check                                # typecheck + lint + 130 tests
pnpm crash-test -- --seeds 2000 --p 0.05     # writes results/crash-test.md and .json
pnpm build                                # static site in apps/web/dist
```

`pnpm crash-test` options: `--seeds N`, `--p <crash probability>`, `--only <config,...>`, `--skip <config,...>`, `--threads N`, `--messages N`.

## Crash test results

2,000 seeds, crash probability 0.05 at every crash point, default workload (5,000 messages over 2 sim-hours, 8 partitions). Full output with crash traces: [results/crash-test.md](results/crash-test.md).

| Config | Failed seeds | Over-billed | Under-billed | Crashes injected |
| --- | ---: | ---: | ---: | ---: |
| all safeguards on | 0 / 2000 | $0.00 | $0.00 | 746,507 |
| `commitFirst` | 2000 / 2000 | $0.25 | $16,778.18 | 613,411 |
| `noDedupStore` | 2000 / 2000 | $27,536.39 | $0.00 | 764,192 |
| `dedupIgnoresBatchId` | 2000 / 2000 | $0.00 | $10,547.52 | 711,446 |
| `nondeterministicBatches` | 2000 / 2000 | $0.00 | $489.88 | 636,117 |
| `blindUpsert` | 2000 / 2000 | $8,386.32 | $0.00 | 746,507 |
| `restampReplay` | 2000 / 2000 | $0.00 | $10,547.52 | 711,446 |
| `processingClock` | 0 / 2000 | $0.00 | $0.00 | 746,507 |

`processingClock` cannot fail on the default workload: no copy sits near the 35-day retention edge (see RATIONALE, "Open findings").

## Layout

```
packages/engine/   dependency-free engine: types, stores, worker, scheduler, workload, invariants
packages/oracle/   independent oracle (lint forbids importing the engine)
apps/crash-test/      seed runner, ledger-vs-oracle check, crash-test CLI
apps/web/          Vite + React demo; the crash test runs in Web Worker
results/           crash-test output
docs/RATIONALE.md  design write-up
```

## Deploy

`.github/workflows/pages.yml` builds `apps/web` and publishes it to GitHub Pages on every push to `main` (enable Pages with source "GitHub Actions" in the repo settings). The build is a static site with relative paths, so Vercel or Cloudflare Pages work too: build command `pnpm build`, output `apps/web/dist`.
