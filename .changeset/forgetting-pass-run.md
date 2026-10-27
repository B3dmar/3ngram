---
"@3ngram/llm": minor
"@3ngram/core": minor
"@3ngram/db": patch
---

Add the forgetting pass's run (docs/concepts/forgetting-pass.mdx). Nothing schedules it yet: the worker job and its flag ship next, default off.

- **Core:** `runForgettingPass(userId, { gateway, budget })` reads one tenant's candidates, judges them in batches through `gateway.decide()` and stages the verdicts as retention proposals. It returns counts only.
  - It stops when the tenant has not opted in to judgment, re-checking the opt-in immediately before every call.
  - It stops without a fallback when the deployment has no judgment gateway.
  - It stops at the first refused budget reservation instead of billing past the cap.
  - Each batch is staged as soon as it returns. Usage is recorded unpriced under the new operation.
  - `dbForgettingRepo` is the production wiring.
- **llm:** registers the metered judgment operation `memory.forget.decide`, with a $0.003 per-call ceiling sized like the closer's judgment call.
- **db:** a stale single named as the related memory of an OPEN proposal, such as the newer side of a supersede waiting for review, is skipped while that proposal is open. Before, this applied to conflicts only. Once the proposal is decided or dismissed, the memory can be judged again, because it was only evidence.
