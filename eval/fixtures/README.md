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

The threshold sweep is computed on the `dev` split only, and precision is reported per split. Judge
thresholds are selected only on the calibration fixture below; on any other file the sweep is a
diagnostic, never a selection.

## Forgetting-pass calibration fixture (`forgetting-calibration.json`)

Pre-registered by the owner decision of 2026-11-03: "Judge thresholds are selected only on the dev
split of a public synthetic fixture in the engine's eval/. Every personal item, historical or fresh,
is held-out evidence only." The enablement bar is unchanged and is read only on the private set's
held-out split. A result on this fixture never satisfies it, and nothing here enables the pass.

Same schema, wholly invented: a fictional software studio (projects wren, heron, sorrel, larkspur,
kestrel, studio-ops) and its lead's fictional personal life, written without reference to any
personal source. It names no real person, company or client. Every label is `dev`, and every label
sits on a judged candidate (a single, or a pair's older side). The slice mix is the eval plan's
target, so thresholds transfer:

| Slice | Labels | Candidates | Expected |
|---|---|---|---|
| stale-archive | 60 | singles: 24 decision, 16 preference, 20 fact | archive |
| conflicting-pair | 40 | pairs, similarity 0.82 to 0.92 | supersede 25, conflict 15 |
| still-valid | 60 | 45 singles, 15 near-duplicate pairs | keep |
| recurring-episodic | 30 | singles: 18 event, 12 dated note | keep (never collapse) |

Every single is stale (older than 30 days at `now`), in the candidate query's order, with up to
three newer same-type neighbours. Some neighbours are evidence, such as a project parked or a car
sold, and the rest are unrelated memories. Hard cases include near-duplicate pairs where both sides
hold, a series of episodes whose later entry reads like a correction, and old, dated items that
still hold. Archive items carry no give-away words. Supersede newers signal an update; conflict
newers give no sign of which side holds. Memory type identifies the episodic slice and the kind (single
or pair) separates pair labels from single labels, both by design. Within those groups,
`eval/test/forgetting-calibration.test.mjs` checks that no length, position, age, neighbour-count or
similarity threshold recovers a label more than 0.15 above the majority baseline. The highest such
gain in this fixture is 0.109. There are no blockers: they cannot be archived, so a blocker would
only ever be a keep.

**Frozen in #399, before any judge run.** The harness pins both checksums
(`eval/src/forgetting-thresholds.mjs`) and the unit test recomputes them:

- file SHA-256: `6e3653884804a257255bf3c8a5fa7997fd637a081d50009207f95e59a6920b3b`;
- label checksum: `8aaf06abc1243a575d2e8dd87de81fdcbe1d6b4495144abea8c2e87ffd70a7b0`, the SHA-256 of
  `JSON.stringify` over the labels sorted by id, each as `[id, slice, expected, relatedMemoryId or
  null, split]`.

A changed byte makes a new fixture and needs a new pre-registration.
`forgetting-calibration-fake-answers.json` is a deterministic wiring fake for CI, not judge output.
Thresholds selected with it record model `fake-judgment`, and a live run refuses them.

The two steps:

```bash
# 1. Select on the calibration fixture's dev split (refused on any other file).
node eval/src/forgetting-eval.mjs --golden eval/fixtures/forgetting-calibration.json \
  --live --select-thresholds eval/private/thresholds.json
# 2. Score the private set with those thresholds frozen (no sweep is reported).
node eval/src/forgetting-eval.mjs --golden eval/private/<golden>.json \
  --live --thresholds eval/private/thresholds.json
```

The selection rule (`SELECTION_RULE`) takes, per action, the lowest swept threshold whose dev
precision reaches 0.95 for archive and supersede, or 0.80 for conflict, over at least 10 proposals.
When no threshold qualifies, it selects none, and that action proposes nothing. Step 2 refuses a
thresholds file whose source hash is not the pinned fixture, or whose model differs from the run's.
In a frozen run the `pass` counts still use the pass's built-in thresholds, while `verdicts` and
every split use the frozen ones.
