---
'@3ngram/db': patch
---

Keep both supersession proposal endpoints locked through acceptance so a concurrent revision cannot retire the proposed successor between its liveness check and the predecessor close.
