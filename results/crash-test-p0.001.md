# Crash test results

`pnpm crash-test -- --seeds 2000 --p 0.001`, crash probability 0.001 at every crash point, default workload (PLAN.md).

| Config | Seeds | Failed seeds | Over-billed | Under-billed | Invariant violations | Crashes injected | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| all safeguards on | 2000 | 0 (0%) | $0.00 | $0.00 | 0 | 12,274 | pass |
| `atMostOnce` | 2000 | 1943 (97.2%) | $0.07 | $356.82 | 0 | 12,228 | pass |
| `noDedupStore` | 2000 | 2000 (100%) | $27,536.39 | $0.00 | 0 | 12,558 | pass |
| `dedupIgnoresBatchId` | 2000 | 1883 (94.2%) | $0.00 | $216.75 | 0 | 12,258 | pass |
| `nondeterministicBatches` | 2000 | 426 (21.3%) | $0.00 | $9.36 | 0 | 12,235 | pass |
| `atLeastOnce` | 2000 | 1707 (85.3%) | $153.85 | $0.00 | 0 | 12,274 | pass |
| `restampReplay` | 2000 | 1883 (94.2%) | $0.00 | $216.75 | 0 | 12,258 | pass |

Verdict: "all safeguards on" passes with 0 failed seeds; each break-it toggle passes when it fails at least one seed.

## First failing seed per toggle

### `atMostOnce`: seed 1

under-billed $0.18; 14 ledger rows differ; 4 crashes in the run.

```
1790815032950 P0 CRASH C4 (1,37) restartAt=1790815043276
1790816240150 P5 CRASH C2 (1,58) restartAt=1790816256019
1790816421300 P1 CRASH C3a (1,61) restartAt=1790816434334
1790817930500 P7 CRASH C1 (1,88) restartAt=1790817938313
```

### `noDedupStore`: seed 1

over-billed $13.20; 282 ledger rows differ; 4 crashes in the run.

```
1790815032900 P4 CRASH C3 (1,37) restartAt=1790815043226
1790816240250 P1 CRASH C3 (1,58) restartAt=1790816256119
1790816421300 P2 CRASH C3a (1,61) restartAt=1790816434334
1790817929950 P0 CRASH C2a (1,86) restartAt=1790817937763
```

### `dedupIgnoresBatchId`: seed 1

under-billed $0.10; 9 ledger rows differ; 4 crashes in the run.

```
1790815032950 P0 CRASH C4 (1,37) restartAt=1790815043276
1790816240150 P5 CRASH C2 (1,58) restartAt=1790816256019
1790816421200 P4 CRASH C2 (1,61) restartAt=1790816434234
1790817930300 P3 CRASH C2a (1,87) restartAt=1790817938113
```

### `nondeterministicBatches`: seed 5

under-billed $0.00; 1 ledger rows differ; 9 crashes in the run.

```
1790813524200 P1 CRASH C4 (1,12) restartAt=1790813541742
1790813524200 P7 CRASH C4 (1,12) restartAt=1790813543153
1790813704950 P5 CRASH C1 (1,15) restartAt=1790813710749
1790814990592 P1 CRASH C1 (2,38) restartAt=1790815002007
1790815575950 P6 CRASH C2 (1,46) restartAt=1790815584558
1790815967907 P1 CRASH C3 (3,54) restartAt=1790815978193
1790817749100 P3 CRASH C1 (1,84) restartAt=1790817767967
1790817828667 P3 CRASH C4 (2,85) restartAt=1790817843326
1790819146258 P6 CRASH C4 (2,107) restartAt=1790819166680
```

### `atLeastOnce`: seed 1

over-billed $0.06; 5 ledger rows differ; 4 crashes in the run.

```
1790815032950 P0 CRASH C4 (1,37) restartAt=1790815043276
1790816240150 P5 CRASH C2 (1,58) restartAt=1790816256019
1790816421200 P2 CRASH C2 (1,61) restartAt=1790816434234
1790817930050 P4 CRASH C3 (1,86) restartAt=1790817937863
```

### `restampReplay`: seed 1

under-billed $0.10; 9 ledger rows differ; 4 crashes in the run.

```
1790815032950 P0 CRASH C4 (1,37) restartAt=1790815043276
1790816240150 P5 CRASH C2 (1,58) restartAt=1790816256019
1790816421200 P4 CRASH C2 (1,61) restartAt=1790816434234
1790817930300 P3 CRASH C2a (1,87) restartAt=1790817938113
```

