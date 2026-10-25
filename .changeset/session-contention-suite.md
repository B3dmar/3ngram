---
---

Test-only: a reusable two-connection barrier harness (`packages/db/test/integration/concurrency.ts`) and a real-concurrency suite for the session-locking claims — one `activation_epoch` bump per resurrection under N concurrent writers, attach vs explicit close in both orders, the omitted-id attach's zero/one/many count holding at commit, attach vs account-erasure lock order, and heartbeat vs erasure on the shared account-lifecycle lock (#178).
