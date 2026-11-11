# Crash test results

`pnpm crash-test -- --seeds 2000 --p 0.001`, crash probability 0.001 at every crash point, default workload (PLAN.md).

| Config | Seeds | Failed seeds | Over-billed | Under-billed | Invariant violations | Crashes injected | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| all safeguards on | 2000 | 0 (0%) | $0.00 | $0.00 | 0 | 12,274 | pass |
| `nondeterministicBatches` | 2000 | 426 (21.3%) | $0.00 | $9.36 | 0 | 12,235 | pass |
| `dedupIgnoresBatchId` | 2000 | 1883 (94.2%) | $0.00 | $216.75 | 0 | 12,258 | pass |
| `atLeastOnce` | 2000 | 1707 (85.3%) | $153.85 | $0.00 | 0 | 12,274 | pass |
| `atMostOnce` | 2000 | 1219 (61.0%) | $0.00 | $59.12 | 0 | 12,248 | pass |

Verdict: "all safeguards on" passes with 0 failed seeds; each break-it toggle passes when it fails at least one seed.

## First failing seed per toggle

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

### `dedupIgnoresBatchId`: seed 1

under-billed $0.10; 9 ledger rows differ; 4 crashes in the run.

```
1790815032950 P0 CRASH C4 (1,37) restartAt=1790815043276
1790816240150 P5 CRASH C2 (1,58) restartAt=1790816256019
1790816421200 P4 CRASH C2 (1,61) restartAt=1790816434234
1790817930300 P3 CRASH C2a (1,87) restartAt=1790817938113
```

### `atLeastOnce`: seed 1

over-billed $0.06; 5 ledger rows differ; 4 crashes in the run.

```
1790815032950 P0 CRASH C4 (1,37) restartAt=1790815043276
1790816240150 P5 CRASH C2 (1,58) restartAt=1790816256019
1790816421200 P2 CRASH C2 (1,61) restartAt=1790816434234
1790817930050 P4 CRASH C3 (1,86) restartAt=1790817937863
```

### `atMostOnce`: seed 3

under-billed $0.11; 10 ledger rows differ; 9 crashes in the run.

```
1790812980900 P1 CRASH C2a (1,3) restartAt=1790812992013
1790813041350 P4 CRASH C3 (1,4) restartAt=1790813062501
1790813123101 P4 CRASH C2a (2,6) restartAt=1790813149913
1790814743513 P1 CRASH C3a (2,35) restartAt=1790814765698
1790816421300 P0 CRASH C3a (1,61) restartAt=1790816433265
1790817301448 P1 CRASH C3a (3,80) restartAt=1790817313813
1790817629050 P5 CRASH C4 (1,83) restartAt=1790817656824
1790818956800 P3 CRASH C1 (1,106) restartAt=1790818977389
1790819226174 P5 CRASH C2 (2,110) restartAt=1790819237384
```

