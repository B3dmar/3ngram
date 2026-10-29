# Eval fixtures

Committed inputs for the eval harness. The blocking gate's fixtures (`golden-set.json`,
`queries.json`, `embeddings-*.json`, `floors.json`, `tool-selection*.json`,
`transport-*.json`) are described in `eval/README.md`.

## Forgetting-pass golden set (`forgetting-synthetic.json`)

The forgetting pass (`docs/concepts/forgetting-pass.mdx`, "Eval plan") is scored by
`eval/src/forgetting-eval.mjs`, which is **report-only**. The real golden set is built from
one consenting account's memories and is **private**: it lives outside this repository and is
passed with `--golden <path>` (a local copy belongs under the gitignored `eval/private/`).
`forgetting-synthetic.json` is a small invented mirror in the same schema, so CI can test the
wiring; `forgetting-synthetic-answers.json` holds the fake judge's answers for it.

Schema (version 1):

```jsonc
{
  "version": 1,
  "now": "2026-10-28T04:30:00.000Z",        // optional; the pass's clock (default: run time)
  "candidates": {                            // what the candidate query returned, verbatim
    "singles": [ForgettingMemory],           // stale singles, in query order
    "neighbours": [NewerNeighbour],          // newer memories shown beside a single, keyed by forId
    "pairs": [ConflictPair]                  // { newer, older, similarity, olderStale }
  },
  "labels": {
    "<memoryId>": {
      "slice": "stale-archive" | "conflicting-pair" | "still-valid" | "recurring-episodic",
      "expected": "archive" | "supersede" | "conflict" | "keep",
      "relatedMemoryId": "<memoryId>",        // optional; the newer side of a supersede or conflict
      "split": "dev" | "heldout"
    }
  }
}
```

`ForgettingMemory`, `NewerNeighbour` and `ConflictPair` are the `@3ngram/db` types from
`packages/db/src/forgetting-candidates.ts`, with dates as ISO strings. A pair's label sits on the
**older** memory id, because the pass records every pair verdict on the older memory. The harness
judges whatever candidates the file provides; a labelled memory that is not a candidate counts as
kept, since the pass never saw it.

The answers file maps question refs to `DecideAnswer`s. Refs are positional from the pass
(`p0, p1, ...` for pairs in array order, then `s0, s1, ...` for singles not already in a pair;
a single's neighbours are `s<i>n<j>`; a pair dropped for sharing a memory with an earlier pair does
not consume a ref), so regenerate the answers whenever the candidates change: run the pass once with
a bare `createFakeGateway()` and read `calls.decide[*].request.questions`. The harness fails when
the answers' refs do not match the refs the pass asked, since the fake would otherwise answer a
missing ref with keep at p=0.05 and ignore an extra one.

The threshold sweep is computed on the `dev` split only; precision is reported per split, so the
`heldout` numbers stay untouched by the threshold choice (the #166 protocol).
