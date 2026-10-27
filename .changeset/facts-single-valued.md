---
"@3ngram/schema": minor
"@3ngram/db": minor
"@3ngram/core": minor
"@3ngram/server": minor
---

Facts supersede (#369). A fact key `(subject, predicate)` is now single-valued by default, so writing a new value no longer leaves the old one current.

- **Replacing:** a new value closes every open value of the key that started at or before it, at its own `validFrom`. That includes values written with `cardinality: "many"`.
- **Backdating:** a backdated value is stored as history that ends where the next newer open value starts.
- **One write, several values:** values of one key are applied in `validFrom` order, and each ends no later than the next one starts, so a series forms a chain. At the same instant, the last value wins.
- **Concurrency:** writers of one key are serialized, so concurrent writes cannot leave two values open. Values written without `validFrom` are ordered by transaction start.
- **Opting out:** a fact marked `cardinality: "many"`, a new optional field on `remember` facts, holds several values at once and closes nothing. A fact written with its own `validTo` is a closed interval and closes nothing.
- **Other writers:** accepting a fact proposal writes a single-valued fact. Import replays exported windows verbatim.
- **History:** closing a window is the only change an existing fact row ever sees, and `asOf` and `range` reads still return every value. A value already closed is never shortened, so a value later backdated into its window overlaps it in history.
- **`@3ngram/db` API:** `insertFacts` and `insertFact` take an optional `{ supersede }` option, which defaults to true. New exported types are `FactCardinality` and `InsertFactsOptions`.

Facts written before this release keep their windows. A key that already has several open values has all of them closed at the start of its next single-valued write.
