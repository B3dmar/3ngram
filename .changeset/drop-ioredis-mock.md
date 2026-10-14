---

---

Test and devDependency only: drop `ioredis-mock` (and its `fengari` -> `sprintf-js` chain, GHSA-hp3w-g68c-fv3c) from `@3ngram/server`; the exchange-failure tracker test now runs against an in-memory fake. No published output changes.
