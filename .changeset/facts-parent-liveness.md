---
"@3ngram/db": patch
"@3ngram/server": patch
---

`get_facts` no longer returns a fact as current after the memory that asserted it was superseded through `revise` or archived (#369).

- **Current reads** require a live parent memory: not superseded and not archived.
- **`asOf` reads** require that the parent had not been superseded at the requested instant. Archive has no timestamp, so it does not hide facts from time travel.
- **`range` reads** are unchanged and still return every generation.

`revise` cannot carry facts, so revising a memory retires its facts. Write a still-true value again through `remember` to keep it current.
