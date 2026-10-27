---
"@3ngram/config": minor
"@3ngram/core": minor
"@3ngram/worker": minor
---

Schedule the forgetting pass on the worker (docs/concepts/forgetting-pass.mdx), default off.

- **`FORGETTING_PASS_ENABLED`** (default `false`, loaded with `loadForgettingPassConfig`) gates a daily `forgetting-pass` job at 04:30 UTC. It is a kill switch in the same way the closer's flag is: with it off the durable scheduler is removed and a residual job is a completed no-op.
- **The one-shot worker** gains `node dist/once.js forgetting-pass`. It exits `0` without running while the flag is off, and `1` when a tenant's pass failed.
- **Core** adds `forgetAllTenants`. It runs the pass for every tenant: a tenant without the judgment opt-in is skipped without reads, one tenant's failure is counted without stopping the others, and a missing judgment gateway ends the loop.
- **Operations:** the job uses the closer's gateway and budget, built once per process. It only stages proposals for review and never changes a memory.

The flag is wired through `.env.example`, `.env.selfhost.example` and both Compose files. The job is in the operate guide's job table.
