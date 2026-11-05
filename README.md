# Exactly-Once Delivery Billing

A crash-anywhere simulation of an exactly-once billing pipeline, with a torture test that proves the ledger never over- or under-bills. See [PLAN.md](PLAN.md).

## Run

Requires Node 24 and pnpm 10.

```sh
pnpm install
pnpm check   # typecheck + lint + test
```
