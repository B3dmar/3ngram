# Golden-set eval

> **Public fixture notice:** the committed golden set was anonymized for public
> release and manually reviewed by the project owner. Names, organizations,
> domains, contact details, repositories, identifiers, and commercial figures in
> these fixtures are synthetic or substituted; they are not operational contact
> details or production endpoints.

**Blocking gate** (`pnpm --filter @3ngram/eval run gate`, CI `eval-gate` job): deterministic, zero-dependency, no network — pure exact-cosine retrieval over committed cached embeddings. Exact cosine is the retrieval upper bound; HNSW-approximation parity (incl. the filtered/distractor scenario) is proven by `packages/db/test/integration/hnsw-parity.int.test.ts`. The DB-level tenant-isolation slice lives in the `test` job's `ci-smoke-app.sql` (real RLS, runtime role).

## Slices (fixtures/queries.json — queries over anonymized production memories)

| Slice | n | Measures |
|---|---|---|
| retrieval | 69 | recall@5, MRR@5 — self-labeled (query generated from its memory) |
| supersession | 19 | successor ranks above its superseded predecessor with superseded rows *included* — proves ranking, not just filtering (real `replaces` pairs from anonymized production memories) |
| abstention | 10 | top-1 similarity below calibrated τ for verifiably-absent topics |

## Floors (fixtures/floors.json)

Recorded from the first run as an empirical ratchet: floors only move up (`record-floors` in a PR, with a week of stability). A run below any floor exits 1 → `eval-gate` fails → no merge.

## Embedding model

`text-embedding-3-large` @ `dimensions: 1536`. Same storage as 3-small, better on every metric that differed.

## Advisory tier (non-blocking)

`pnpm --filter @3ngram/eval run advisory` (`src/longmemeval.mjs`) runs the **advisory** LongMemEval slice. It is deterministic, zero-dep and offline like the gate, but it **never blocks a PR** — it runs only in `eval-nightly.yml` (scheduled), which opens/updates a tracking issue on regression and closes it on green.

Slice 1 (shipped): a LongMemEval-S-shaped subset (`fixtures/longmemeval-s-subset.json`, synthetic + license-clean) scored by a deterministic lexical (token-overlap) retrieval-oracle — `session_recall@k` / `session_mrr` over `answer_session_ids` gold labels. The lexical ranker (`lib.rankSessions`) is the **default** and the only path PR-lane unit tests touch — it stays network/DB/model-free.

Opt-in slices (never in the default path):

- `--retriever real` (or `EVAL_RETRIEVER=real`) — the **real Phase-1B retriever** (see below).
- `--download` — streams the full 500q LongMemEval-S haystack into a gitignored cache (large + upstream license; not committed).
- `--judge` — model-judged answer-synthesis slice (needs an API key; never a silent network dependency).

### Real-retriever mode (`--retriever real`)

`pnpm --filter @3ngram/eval run advisory:real` (or `node src/longmemeval.mjs --retriever real`) swaps the lexical stand-in for the **product retrieval path** (`retriever.mjs`):

1. Per question, a **disposable tenant** (fresh user) is created. The nightly Neon branch is ephemeral (created per run, deleted at job end), so questions stay isolated and re-runs are idempotent with no destructive cleanup on a write path (hard rule 1).
2. Each haystack session is seeded as memory via the product write path — `core.remember(..., { gateway })`, which lands the embedding through embed-on-write using the real `@3ngram/llm` `createOpenAIGateway`. A session whose text fits the `rememberInputSchema` content cap (`MAX_CONTENT_LENGTH` = 2000) becomes **one** memory; a longer session is **chunked at the cap** and the session ranks by its **best chunk**.
3. The question is embedded via the same gateway and `core.search()` runs the product fusion (`{fts:0.2, recency:0, vector:1}`); sessions rank by their best-scoring memory hit.

Real mode requires the built workspace (`pnpm build`) plus a DB and an embedding gateway. It is the **nightly advisory lane only** and **skips cleanly** (clear log, exit 0) when a prerequisite is absent — never a silent dependency.

#### Skip conditions (real mode)

| Condition | Behaviour |
|---|---|
| `DATABASE_URL` unset | `--retriever real` logs the reason and exits 0 (no DB). |
| `LLM_GATEWAY_API_KEY` unset | `--retriever real` logs the reason and exits 0 (no embedding gateway). |
| Nightly: Neon (`NEON_PROJECT_ID`/`NEON_API_KEY`/`APP_USER_PASSWORD`) **or** `LLM_GATEWAY_API_KEY` unset | The whole real-retriever block in `eval-nightly.yml` skips (preflight gate); the run stays green. |
| `LLM_GATEWAY_URL` unset | Falls back to `https://api.openai.com/v1` (empty string treated as unset). |
| Default / `--retriever lexical` | Pure lexical oracle; no DB, network, or workspace build. |

Remaining work: measure live-slice stability ≥4 weeks before any blocking consideration.

### MemoryAgentBench subsets (`src/memoryagentbench.mjs`)

`pnpm --filter @3ngram/eval run advisory:mab` (or `node src/memoryagentbench.mjs`) runs the **second** advisory benchmark: the two MemoryAgentBench (MAB) subsets — **Conflict Resolution** (detect + overwrite outdated facts so only the newest valid value is returned) and **Test-Time Learning** (ingest a user-supplied rule/label mid-dialogue, then apply it). It is advisory-only and wired into `eval-nightly.yml` (slice 5); it **never blocks a PR** (≥4 weeks of stability before any blocking promotion).

The MAB metric **shape differs** from LongMemEval: it is **accuracy-over-turns** (per question, did the agent answer correctly after ingesting the haystack turns), **not** `session_recall@k` / `MRR`. The harness emits a distinct per-run JSON metrics shape — overall `accuracy` plus per-subset accuracy under `by_subset` (`conflict-resolution` / `test-time-learning`) — never the LongMemEval oracle output.

Default path (the only path PR-lane unit tests touch) is a deterministic, zero-dep, offline accuracy oracle over `fixtures/memoryagentbench-subset.json` (synthetic + license-clean): it ranks haystack sessions by lexical token-overlap (`lib.rankSessions`, shared with the LongMemEval oracle), then breaks ties by **recency** (newest `session_date` first — the Conflict Resolution semantic: an old and new session can match equally on tokens, so the agent must return the *newest* value), extracts the predicted answer from the top session's `has_answer` turns, and scores a hit iff the gold answer is contained there. Swap `lib.rankSessions` for the real Phase-1B retriever when it lands — identical to the LongMemEval lane.

Opt-in `--download` slice: streams the **official MIT-licensed** upstream subsets (`ai-hyz/MemoryAgentBench` on HuggingFace — `Conflict_Resolution` + `Test_Time_Learning` parquet) into the gitignored cache, **pinning** `url` + `sha256` + `bytes` per subset (same empty-string-safe env-override contract as the LongMemEval lane; overridable via `MAB_<SUBSET>_URL` / `_SHA256` / `_BYTES`).

> **Deferred (no dependency added this batch):** parquet **decoding** of the downloaded subsets. The single lockfile slot was owned by another track, so no parquet-reader dependency was added. The `--download` lane therefore verifies pinned integrity (url/sha256/bytes) and reports a content-free result, but does **not** yet run the oracle over the decoded official rows — the default offline lane uses the synthetic fixture. Wiring the decode (vendored or zero-dep reader) is a follow-up.

## Tool-selection + description overlap (report-only, inside the gate)

`src/tool-selection.mjs` measures what the MCP tool cap is a *proxy* for
(`docs/concepts/mcp-surface.mdx`): whether an agent utterance routes to the right tool,
and how much the tool descriptions overlap each other. It runs **inside** `run.mjs` and
prints alongside the gated metrics, but it is **report-only — no floors, and it can never
move the exit code**. Floors are deliberately deferred to a later PR that baselines them
from this slice's observed output.

| Metric | Meaning |
|---|---|
| `selection_accuracy_at_1` | the nearest tool **description** (cosine) is the tool the utterance should reach |
| `selection_margin` | mean top1−top2 cosine gap — how *decisively* the right tool wins |
| `max_description_overlap` | largest pairwise cosine between two tool descriptions, reported with the offending pair |
| `surface_slice` | the non-tool scenarios (memory resource / `briefing`+`debrief` prompts): how hard the tool descriptions pull on a need that is not a tool's |

Nearest-description-by-cosine is a deterministic **proxy** for a model's tool choice, not
a model run — the same substitution the blocking gate makes for the product retriever.

- Scenarios: `fixtures/tool-selection.json` — exactly 5 agent utterances per registered
  tool (55; pinned by a unit test) plus a separate `surfaceScenarios` array whose correct
  target is not a tool.
- Descriptions come from the committed `fixtures/transport-surfaces.json` (the real
  `tools/list` capture). **Every embedded text — each tool description AND each scenario
  utterance — is stored with a sha256 of the exact string.** A description edit, an
  utterance retuned in place (ids are stable, so this is the easy one to miss), a new
  tool, or a retired tool makes the slice fail loudly with a regenerate instruction
  instead of scoring a stale vector. Vectors are also rejected at both ends — generation
  and load — if any element is non-finite or the L2 norm is zero, since cosine against a
  zero vector is NaN and NaN would report as a metric rather than fail.
- **Absence of the embeddings fixture is not a failure**: the gate prints
  `fixture not generated` and stays green.

Regenerate (needs an embedding credential; one command):

```bash
OPENAI_API_KEY=… pnpm --filter @3ngram/eval run gen:tool-selection
```

Optional: build `apps/server` first (`pnpm --filter @3ngram/server build`) and the
generator additionally cross-checks the committed capture against the **live** registry,
refusing to generate from a stale one. Without the build it prints that the cross-check
was skipped.

Standalone (exits 2 on an integrity failure — the gate wiring does not):

```bash
pnpm --filter @3ngram/eval run tool-selection [-- --json]
```

## Tool-selection: model-in-the-loop (advisory, nightly-only)

`src/tool-selection-model.mjs` is the model-in-the-loop counterpart to the
deterministic embedding-cosine proxy above. It runs **only** in
`eval-nightly.yml` (never inside the gate) and, for every `toolScenarios`
entry in `fixtures/tool-selection.json`, presents a live model with the REAL
tool catalog (names + descriptions from `fixtures/transport-surfaces.json`
`mcp.tools`) and forces a bare tool-name answer.

| Metric | Meaning |
|---|---|
| `model_selection_accuracy_at_1` | overall + `per_tool`: did the model's forced pick match `expected_tool`? |
| `unparseable_rate` | share of replies that were not an exact registered tool name — scored as incorrect, never as a harness error |
| `confusions` | directed `expected -> predicted` pairs, `unparseable` used as the predicted label when the reply didn't parse |
| `proxy_model_agreement` | how often the model's pick matches the deterministic proxy's pick, computed by reusing `tool-selection.mjs`'s own `rankTools` — only when the tool-selection embeddings fixture is present and valid; absent or corrupt skips this section with a clear note, never a failure |
| `served_model` / `served_model_varied` | the response body's actual `model` field (first observed value) and whether it varied across calls — provenance for the requested alias, since e.g. `gpt-4o-mini` floats to whatever the provider currently points it at |
| `n` / `n_answered` / `gateway_error_count` | a per-scenario gateway failure (timeout, non-OK response) is caught, not propagated, and recorded as its own pick class — excluded from `model_selection_accuracy_at_1` / `unparseable_rate` (those are model-behavior metrics) rather than discarding the whole run; `n_answered` is the explicit denominator both rates use |

Gateway contract mirrors `--judge` (`src/judge.mjs`): `LLM_GATEWAY_API_KEY` /
`LLM_GATEWAY_URL`, 30s timeout. Model override is `LLM_TOOL_SELECTION_MODEL`
(default `gpt-4o-mini`) — kept distinct from `LLM_JUDGE_MODEL` so the two
advisory lanes can point at different models independently; `eval-nightly.yml`
passes it from the `LLM_TOOL_SELECTION_MODEL` repo/org Actions **variable**
(not a secret — it's a model name). **Skips cleanly** (clear log line, exit
0 — `{"status":"skipped","reason":…}` under `--json`) when
`LLM_GATEWAY_API_KEY` is absent — never a silent network dependency.

```bash
LLM_GATEWAY_API_KEY=… pnpm --filter @3ngram/eval run tool-selection-model [-- --json]
```

## Regenerating fixtures (`pipeline/`)

Manual, network-using, in order: export (psql from the production database) → `anonymize.mjs` (Claude Haiku; PII scan after) → `gen-queries.mjs` → `embed.mjs openai-large-1536`. Regeneration invalidates floors — re-record and justify in the PR.
