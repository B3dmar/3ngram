---
"@3ngram/worker": minor
---

One-shot mode accepts `session-sweep` (#315): closers drain in-process after the sweep, deduped by (run, epoch), each as a last attempt so a failure stamps the row-level backoff once (#184).
