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

## Floors and ceilings (fixtures/floors.json)

Recorded from the first run as an empirical ratchet: floors only move up (`record-floors` in a PR, with a week of stability). A run below any floor exits 1 → `eval-gate` fails → no merge.

`recorded` holds the floors (higher is better, compared with `<`). `ceilings` holds the metrics where **lower** is better, compared with `>` — today just `max_description_overlap`, a cosine *between* two tool descriptions that must not grow. The direction lives in the fixture's shape rather than in an inverted value, so a floor can never be read as a ceiling by mistake. A metric named in either block that the run did not produce fails the gate too: "not measured" is never "not regressed".

## Embedding model

`text-embedding-3-large` @ `dimensions: 1536`. Same storage as 3-small, better on every metric that differed.

## Advisory tier (non-blocking)

`pnpm --filter @3ngram/eval run advisory` (`src/longmemeval.mjs`) runs the **advisory** LongMemEval slice. It is deterministic, zero-dep and offline like the gate, but it **never blocks a PR** — it runs only in `eval-nightly.yml` (scheduled), which opens/updates a tracking issue on regression and closes it on green. That issue tracks only slice 1's advisory floor, set in the workflow: the live lanes write metrics but never open it.

Slice 1 (shipped): a LongMemEval-S-shaped subset (`fixtures/longmemeval-s-subset.json`, synthetic + license-clean) scored by a deterministic lexical (token-overlap) retrieval-oracle — `session_recall@k` / `session_mrr` over `answer_session_ids` gold labels. The lexical ranker (`lib.rankSessions`) is the **default** and the only path PR-lane unit tests touch — it stays network/DB/model-free.

Opt-in slices (never in the default path):

- `--retriever real` (or `EVAL_RETRIEVER=real`) — the **real Phase-1B retriever** (see below).
- `--download` — streams the full 500q LongMemEval-S haystack into a gitignored cache (large + upstream license; not committed). The release is pinned in `src/download.mjs` (sha256 + bytes); `LONGMEMEVAL_S_*` env overrides it.
- `--download --sample <fixture>` — scores only the question ids a sample fixture lists (see below).
- `--judge` — model-judged answer-synthesis slice (needs an API key; never a silent network dependency).

Every oracle run reports `by_ability` (LongMemEval's retrieval abilities, each row with its own `n`) and names its `retriever`. Retrieval skips the abstention (`_abs`) questions, as LongMemEval's own protocol does: they have no ground-truth answer location. The output counts them in `abstention_skipped` beside `retrieval_scored`; abstention is an answer-level ability for the judge. A real-retriever run also carries `lexical_baseline`: the stand-in scored on the same questions.

Beside any-recall (`session_recall_at_k`: some gold session in the top k) and MRR, every run reports LongMemEval's own session-level metrics, ported from upstream's `eval_utils.py` (`src/retrieval-metrics.mjs`, #516): `session_recall_all_at_5`/`_10` (every gold session in the top k) and `session_ndcg_any_at_5`/`_10` (binary gain, upstream's DCG). They read the same ranking, so they cost no extra retrieval or embedding call. `--protocol` picks the gold and skip rules, and the output names it in `protocol`:

- `answer-ids` (default): gold is `answer_session_ids`; only abstention is skipped. It keeps every lane's question set and any-recall/MRR unchanged, and still scores the `single-session-assistant` questions, whose evidence our write path stores.
- `upstream`: the rules of LongMemEval's released code. Gold is a session whose id contains `answer` and that has a user turn flagged `has_answer`; a question with no flagged user turn is skipped and counted in `no_target_skipped`. On the pinned file it scores 419 of the 470 non-abstention questions. A file without upstream's ids is refused rather than scored against empty gold. `fixtures/upstream-retrieval-parity.json` pins the port to values upstream's Python produced.
- `paper`: how the paper's published retrieval tables were averaged: upstream gold over every question, abstention included, so a question with no gold counts recall_all 1 and NDCG 0 (`empty_gold` counts them). It is the protocol for comparing with the paper: it reproduces Table 9's BM25 row exactly, where `upstream` does not.

`--retriever bm25` is LongMemEval's own BM25 baseline (`src/bm25.mjs`): a port of `rank_bm25` 0.2.2 `BM25Okapi` with its defaults, over each session's user turns joined by spaces and tokenised by `split(" ")`, exactly as upstream's `run_retrieval.py` calls it. It is offline and deterministic. `fixtures/bm25-parity.json` pins its scores to values `rank_bm25` produced, bit for bit. On the pinned -S file it matches upstream's own BM25 on every question's gold ranks (500 of 500): under `upstream`, recall_all@5 0.7351, NDCG@5 0.7671, recall_all@10 0.8234, NDCG@10 0.7922. Ties rank the later haystack position first, where upstream's numpy argsort is unstable; on -S that changes no gold rank.

**Reproducing a published number.** The paper publishes retrieval numbers only for LongMemEval-M (about 500 sessions per question); for -S it reports QA accuracy only. `--download --dataset m` fetches the pinned -M release (2.7 GB, `src/download.mjs`) and reads it one question at a time (`readJsonArray`), since the file is longer than the longest string V8 allows; a run needs about 3.2 GB of memory and takes about 20 s. With the paper's averaging it reproduces Table 9's session-level BM25 row (key = value) to three decimals:

```bash
node eval/src/longmemeval.mjs --download --dataset m --retriever bm25 --protocol paper --json
# 500 scored, empty_gold 72: recall_all@5 0.634  ndcg@5 0.5164  recall_all@10 0.710  ndcg@10 0.5395
# paper, Table 9:              R@5 0.634          NDCG@5 0.516   R@10 0.710          NDCG@10 0.540
```

Upstream's released code gives the same gold ranks on 498 of 500 -M questions; the other two differ only below rank 200, on ties numpy orders differently.

**QA accuracy (#535, in progress).** `src/qa.mjs` ports upstream's reader prompt (`run_generation.py`, `orig-session` with JSON history, direct and step-by-step) and judge prompts (`evaluate_qa.py`) byte for byte, builds OpenAI Batch `/v1/chat/completions` request lines with upstream's settings (temperature 0; 500, 800 and 10 max tokens), parses Batch output files and scores as `print_qa_metrics.py` does (overall, task-averaged and abstention accuracy, per type). `--dataset oracle` pins `longmemeval_oracle` (each question's evidence sessions only), the input of the paper's oracle results. On all 500 oracle questions the 1,500 reader and judge prompts equal the ones upstream's own functions build; `fixtures/qa-parity.json` pins seven synthetic cases built by upstream's code. `src/qa-batch.mjs` runs it through the OpenAI Batch API as two batches, the reader then the judge, with a state file of ids, models, prices and counts only, so it can travel between CI jobs:

```bash
node eval/src/qa-batch.mjs submit --state run.json --dataset oracle \
  --reader gpt-4o-2024-08-06 --judge gpt-4o-2024-08-06 \
  --usd-in 1.25 --usd-out 5 --max-usd 25 [--cot] [--limit 10] [--part-tokens 1200000]
node eval/src/qa-batch.mjs collect --state run.json --out qa-metrics.json   # repeat until "done"
node eval/src/qa-batch.mjs cleanup --state run.json   # abandon: cancel and delete everything of the run
```

`submit` checks every argument (both `--name value` and `--name=value`) and refuses a run whose cost bound exceeds `--max-usd`. The bound counts each prompt's UTF-8 bytes (a byte-level BPE token covers at least one byte, so this holds for non-ASCII answers too), 32 framing tokens per request and `max_tokens` out, at the given Batch prices per million tokens, compared unrounded; the judge gets what the reader actually spent, billed refusals included, and a judge refusal ends the run as `failed`. The reader runs in parts, one batch at a time: OpenAI's Batch queue limits the tokens enqueued per model (1,350,000 for `gpt-4o` at usage tier 2; the 500 oracle questions need about 3.4M), and a batch over it fails at validation, free, with `token_limit_exceeded`. `submit` splits the reader requests in order into parts of at most `--part-tokens` estimated tokens (default 1,200,000; the estimate is UTF-8 bytes over three plus framing and `max_tokens`, where English prompts run about four bytes per token), and `collect` starts each part once the one before it completes, then the judge once the last does. Every run has a run id: each upload is named `lme-qa-<run id>-<stage>.jsonl` (`reader-<k>` or `judge`) and each batch carries `{ run_id, stage }` in its metadata, so anything the run created can be found by listing every page, even when the response that carried its id was lost. The state is saved before a stage uploads anything (an unwritable state file stops the run unpaid), after the upload and after the batch exists; a resume adopts the named upload and the tagged batch before creating either, so nothing is paid for twice, and `cleanup` cancels the run's running batches and deletes every file it can find for the run id. Every call has a 120 s deadline. `collect` is safe to repeat: it reports `pending` while a batch runs; once the reader's completes it starts the judge batch before letting the reader's files go (with no usable answer it scores all wrong at once); once the judge's completes it writes the metrics (judge and `upstream_judge`, overall, task-averaged and abstention accuracy, per type, token usage and cost), and a finished run returns the same metrics again. A question with no answer or no verdict counts as wrong; a batch that ends failed or expired marks the run failed, and the failure names the batch's error codes and, when OpenAI's Batch queue limit refused it, the limit in enqueued tokens (codes and the number only: an error message can name the organization or quote a request). Batch files hold dataset text and model answers (hard rule 6): they are never printed, and once the state no longer needs them they are queued in `pending_deletes` and deleted right after the state is saved (a file already gone counts as deleted; a failed deletion stays queued). An API call that fails names its method, endpoint and status, and from the error body only its code (or type), the parameter it names and, for the Batch queue limit, the limit, for example `POST /batches failed with status 400 (token_limit_exceeded; limit 1,350,000 enqueued tokens)`. Errors print only messages the code wrote (`ContentFreeError`); any other error's details are withheld, since a parser error can quote the text it failed on. It needs `LLM_GATEWAY_API_KEY` and refuses without it.

**In CI (manual only, paid).** `eval-nightly.yml` runs it on dispatch with `qa_action` set to `submit`, `collect` or `cleanup`; the schedule and `qa_action: nightly` run the nightly lanes as before and never the QA job. The state file travels between dispatches in `actions/cache`, keyed by `qa_run`, and the step summary shows each step's ids, status and counts (and the metrics once done, also uploaded as an artifact). Each QA run has its own concurrency group, so one collector works on a run at a time (#538). Each dispatch also uploads the state as a 90-day artifact, `lme-qa-state-<qa_run>-<run id>`, because a cache entry can be evicted after seven idle days or under storage pressure; a `collect` or `cleanup` that finds no state stops and points to it, and the run then resumes or is cleaned up locally from the downloaded file (`gh run download <run id> -n lme-qa-state-<qa_run>-<run id>`, then `qa-batch.mjs collect` or `cleanup --state run.json`). Dispatch every step of a run from the same branch, since a cache is visible only to its own branch and the default branch:

```bash
gh workflow run eval-nightly.yml --ref staging -f qa_action=submit -f qa_run=anchor-4o \
  -f qa_dataset=oracle -f qa_limit=10 -f qa_max_usd=0.5      # GPT-4o reader and judge at Batch prices by default
gh workflow run eval-nightly.yml --ref staging -f qa_action=collect -f qa_run=anchor-4o   # repeat until "done"
```

### Real-retriever mode (`--retriever real`)

`pnpm --filter @3ngram/eval run advisory:real` (or `node src/longmemeval.mjs --retriever real`) swaps the lexical stand-in for the **product retrieval path** (`retriever.mjs`):

1. Per question, a **disposable tenant** (fresh user) is created. Nightly, the database is the job's throwaway Postgres service container (pgvector, fixed non-secret credentials), discarded with the runner, so questions stay isolated and re-runs are idempotent with no destructive cleanup on a write path (hard rule 1).
2. Each haystack session is seeded as memory via the product write path — `core.remember(..., { gateway })`, which lands the embedding through embed-on-write using the real `@3ngram/llm` `createOpenAIGateway`. A session whose text fits the `rememberInputSchema` content cap (`MAX_CONTENT_LENGTH` = 2000) becomes **one** memory; a longer session is **chunked at the cap** and the session ranks by its **best chunk**.
3. The question is embedded via the same gateway and `core.search()` runs the product fusion (`{fts:0.2, recency:0, vector:1}`); sessions rank by their best-scoring memory hit.

Real mode requires the built workspace (`pnpm build`) plus a DB and an embedding gateway. It is the **nightly advisory lane only** and **skips cleanly** (clear log, exit 0) when a prerequisite is absent — never a silent dependency.

#### Skip conditions (real mode)

| Condition | Behaviour |
|---|---|
| `DATABASE_URL` unset | `--retriever real` logs the reason and exits 0 (no DB). |
| `LLM_GATEWAY_API_KEY` unset | `--retriever real` logs the reason and exits 0 (no embedding gateway). |
| Nightly: `LLM_GATEWAY_API_KEY` secret unset | The whole real-retriever block in `eval-nightly.yml` skips (preflight gate); the run stays green. The database needs no secret. |
| `LLM_GATEWAY_URL` unset | Falls back to `https://api.openai.com/v1` (empty string treated as unset). |
| Default / `--retriever lexical` | Pure lexical oracle; no DB, network, or workspace build. |

Remaining work: measure live-slice stability ≥4 weeks before any blocking consideration.

### Real-retriever sample (`--sample`, cached embeddings, #449)

The 5q subset says little about the real retriever: each question has 2 or 3 sessions, so
recall@5 is 1.0 by construction. The sample lane scores it on real LongMemEval-S questions:

```bash
EVAL_EMBED_CACHE=eval/.cache/embeddings/longmemeval-s-sample-50.jsonl \
  node eval/src/longmemeval.mjs --download --sample longmemeval-s-sample-50 --retriever real --json
```

- **Sample.** `fixtures/longmemeval-s-sample-50.json` lists 50 question ids, stratified by
  type (12 multi-session, 12 temporal, 8 knowledge-update, 7, 6 and 5 single-session) with 5
  abstention questions, so retrieval scores 45 and the judge can score all 50. It records
  the dataset sha256 it was drawn from; a different
  release, or an id the dataset lacks, exits 2. Ids only: no upstream text is committed.
  Regenerate with `node eval/scripts/gen-longmemeval-sample.mjs` (deterministic, seed 449);
  that changes what the lane scores, so say so in the PR.
- **Embedding cache.** `EVAL_EMBED_CACHE` wraps the gateway in `src/embedding-cache.mjs`,
  keyed by sha256 of model, dimensions and exact text. Before seeding, the retriever
  prefills every chunk and question of the 45 scored questions in batches of 256 (about 50
  requests and 5M tokens cold, about $0.67); the per-memory embeds that follow are hits,
  and a miss still calls the live gateway. A batch that hits a rate limit, a server error,
  a timeout or a network failure is retried whole up to 4 times, waiting the provider's
  `Retry-After` in full (bounded at 10 min) or else 2, 4, 8, 16 s; if it still fails, its
  texts are counted as failed rather than sent one per call into the same limit. Any
  other failure is retried one text per call. Each batch is written to the file as soon as it is paid for, so a run killed later
  keeps it. `batch_retries` counts the waits. Vectors are served after a float32 round trip,
  so cold and warm runs score identical vectors. Rows carry a checksum; a damaged or
  unterminated file is rewritten whole. The header records the model the gateway served,
  and a different served model aborts the run rather than mixing vectors; a new gateway
  needs a fresh cache. The file holds hashes and vectors only. `embedding_cache` in the
  output reports hits, misses, live calls, tokens and the served model.
- **Nightly.** Slice 7 of `eval-nightly.yml` restores the cache with `actions/cache`,
  writes `eval-metrics/real-retriever-sample.json`, and saves the cache only when the run
  changed it, judged by `hashFiles` against a hash taken before the run, so a failed or
  timed-out run still saves what it paid for. A warm night makes no embedding calls. The cache is branch-scoped: a cache
  saved on `staging` is not visible to `main` runs.
- **Full set (#517).** Slice 8 scores the real retriever on every question LongMemEval's
  own protocol scores (`--download --protocol upstream`: 419 of the pinned 500), the
  lexical stand-in beside it, into `eval-metrics/real-retriever-full.json`. It keeps its
  own cache (`eval/.cache/embeddings-full/`, key `lme-emb-full-v1-`): 90,550 vectors
  and about 750 MB, so the cache file is read as a Buffer line by line, never as one string
  (V8 caps a string near 512 MiB). Measured on staging: the cold fill (once per branch)
  took 54 min, 34.5M tokens (about $4.49) and 699 calls, 345 of them rate-limit retries;
  a warm night takes 19 min with no embedding calls and identical results. The cache
  entry is 389 MB, and the step timeout is 90 min. It runs nightly so the restore keeps
  the entry inside GitHub's 7-day eviction window. `--ranks-out eval-metrics/real-retriever-full-ranks.jsonl` writes one
  line per scored question: `question_id`, `ability`, `sessions` and the sorted
  `gold_ranks` (ids and numbers only), so a miss can be traced to its questions.

### Live lanes in `eval-nightly.yml`

Three nightly lanes call a live model gateway: the model-judged slice (`--judge`), the
model-in-the-loop tool-selection slice and the real retriever. All three run only when
the `LLM_GATEWAY_API_KEY` repository secret is set, and skip green without it. Nothing
else is required:

| Setting | Kind | Unset means |
|---|---|---|
| `LLM_GATEWAY_API_KEY` | secret | all three lanes skip |
| `LLM_GATEWAY_URL` | secret | `https://api.openai.com/v1` |
| `LLM_TOOL_SELECTION_MODEL` | variable | `gpt-4o-mini` for tool selection |
| `LONGMEMEVAL_S_URL` / `_SHA256` / `_BYTES` | variables | the release pinned in `src/download.mjs` |

The workflow does not pass `LLM_JUDGE_MODEL`, so the judge always uses its
`gpt-4o-mini` default. Per night the lanes make one chat call per tool or capability scenario, two per
LongMemEval subset question, and one embedding call per haystack session and question
(`text-embedding-3-large`, 1536 dimensions). The real-retriever block also runs the 50q
sample lane, which makes no embedding calls once its cache is warm.

### MemoryAgentBench subsets (`src/memoryagentbench.mjs`)

`pnpm --filter @3ngram/eval run advisory:mab` (or `node src/memoryagentbench.mjs`) runs the **second** advisory benchmark: the two MemoryAgentBench (MAB) subsets — **Conflict Resolution** (detect + overwrite outdated facts so only the newest valid value is returned) and **Test-Time Learning** (ingest a user-supplied rule/label mid-dialogue, then apply it). It is advisory-only and wired into `eval-nightly.yml` (slice 5); it **never blocks a PR** (≥4 weeks of stability before any blocking promotion).

The MAB metric **shape differs** from LongMemEval: it is **accuracy-over-turns** (per question, did the agent answer correctly after ingesting the haystack turns), **not** `session_recall@k` / `MRR`. The harness emits a distinct per-run JSON metrics shape — overall `accuracy` plus per-subset accuracy under `by_subset` (`conflict-resolution` / `test-time-learning`) — never the LongMemEval oracle output.

Default path (the only path PR-lane unit tests touch) is a deterministic, zero-dep, offline accuracy oracle over `fixtures/memoryagentbench-subset.json` (synthetic + license-clean): it ranks haystack sessions by lexical token-overlap (`lib.rankSessions`, shared with the LongMemEval oracle), then breaks ties by **recency** (newest `session_date` first — the Conflict Resolution semantic: an old and new session can match equally on tokens, so the agent must return the *newest* value), extracts the predicted answer from the top session's `has_answer` turns, and scores a hit iff the gold answer is contained there. Swap `lib.rankSessions` for the real Phase-1B retriever when it lands — identical to the LongMemEval lane.

Opt-in `--download` slice: streams the **official MIT-licensed** upstream subsets (`ai-hyz/MemoryAgentBench` on HuggingFace — `Conflict_Resolution` + `Test_Time_Learning` parquet) into the gitignored cache, **pinning** `url` + `sha256` + `bytes` per subset (same empty-string-safe env-override contract as the LongMemEval lane; overridable via `MAB_<SUBSET>_URL` / `_SHA256` / `_BYTES`).

> **Deferred (no dependency added this batch):** parquet **decoding** of the downloaded subsets. The single lockfile slot was owned by another track, so no parquet-reader dependency was added. The `--download` lane therefore verifies pinned integrity (url/sha256/bytes) and reports a content-free result, but does **not** yet run the oracle over the decoded official rows — the default offline lane uses the synthetic fixture. Wiring the decode (vendored or zero-dep reader) is a follow-up.

## Tool-selection + description overlap (gated)

`src/tool-selection.mjs` measures what 3ngram's former MCP tool cap was only a *proxy* for
(`docs/concepts/mcp-surface.mdx`): whether an agent utterance routes to the right tool,
and how much the tool descriptions overlap each other. It runs **inside** `run.mjs`, and
its three scalars are **gated** — accuracy and margin as floors, overlap as a ceiling. The
cap is gone; this slice replaced it, so a tool whose description blurs into a neighbour's
fails the gate rather than a code review. A missing or corrupt embeddings fixture exits 2:
a gated slice that did not run is not a pass.

Regenerating the fixture (`scripts/gen-tool-selection-embeddings.mjs`) is required whenever
a tool description changes — the descriptions are hashed into it — and invalidates these
three values, so re-record and justify them in the same PR.

| Metric | Gated as | Meaning |
|---|---|---|
| `selection_accuracy_at_1` | floor | the nearest tool **description** (cosine) is the tool the utterance should reach |
| `selection_margin` | floor | mean top1−top2 cosine gap — how *decisively* the right tool wins |
| `max_description_overlap` | **ceiling** | largest pairwise cosine between two tool descriptions, reported with the offending pair |
| `surface_slice` | diagnostic | the non-tool scenarios (memory resource / `briefing`+`debrief` prompts): how hard the tool descriptions pull on a need that is not a tool's |

`by_tool`, `confusions` and `max_overlap_pair` stay diagnostics as well: they name *which*
tool or pair regressed, which is what makes a gate failure actionable, but only scalars can
be ratcheted.

Nearest-description-by-cosine is a deterministic **proxy** for a model's tool choice, not
a model run — the same substitution the blocking gate makes for the product retriever.

- Scenarios: `fixtures/tool-selection.json` — exactly 5 agent utterances per registered
  tool (55; pinned by a unit test) plus a separate `surfaceScenarios` array whose correct
  target is not a tool, and a **report-only** `capabilityScenarios` array: utterances for
  a second job a tool's input schema carries but its description does not name (today
  `revise#disposition`, the archive/reaffirm `memoryIds` batch). Those are scored per
  `tool#capability` and printed beside the gated metrics, but never enter
  `selection_accuracy_at_1`/`selection_margin`, so neither the floors nor the 5-per-tool
  rule move with them.
- Descriptions come from the committed `fixtures/transport-surfaces.json` (the real
  `tools/list` capture). **Every embedded text — each tool description AND each scenario
  utterance — is stored with a sha256 of the exact string.** A description edit, an
  utterance retuned in place (ids are stable, so this is the easy one to miss), a new
  tool, or a retired tool makes the slice fail loudly with a regenerate instruction
  instead of scoring a stale vector. Vectors are also rejected at both ends — generation
  and load — if any element is non-finite or the L2 norm is zero, since cosine against a
  zero vector is NaN and NaN would report as a metric rather than fail.
- **Absence of the embeddings fixture IS a failure**: the fixture is committed and
  required, so the gate prints `fixture not generated` with the regenerate hint and exits
  2. Every non-ok status does — a gated slice that did not run is not a pass, and exit 2
  (integrity) is kept distinct from exit 1 (a real regression against a floor).

Regenerate (needs an embedding credential; one command):

```bash
OPENAI_API_KEY=… pnpm --filter @3ngram/eval run gen:tool-selection
```

Optional: build `apps/server` first (`pnpm --filter @3ngram/server build`) and the
generator additionally cross-checks the committed capture against the **live** registry,
refusing to generate from a stale one. Without the build it prints that the cross-check
was skipped.

Standalone (exits 2 on any integrity failure, the same verdict the gate reaches — this is
just the faster loop while editing a description):

```bash
pnpm --filter @3ngram/eval run tool-selection [-- --json]
```

## Tool-selection: model-in-the-loop (advisory, nightly-only)

`src/tool-selection-model.mjs` is the model-in-the-loop counterpart to the
deterministic embedding-cosine proxy above. It runs **only** in
`eval-nightly.yml` (never inside the gate) and, for every `toolScenarios` and
`capabilityScenarios` entry in `fixtures/tool-selection.json`, presents a live
model with the REAL tool catalog (names + descriptions from
`fixtures/transport-surfaces.json` `mcp.tools`) and forces a bare tool-name
answer. Capability scenarios are reported only in `capability_slice`. Every
other metric below covers the tool scenarios alone, except `served_model` /
`served_model_varied`, which span every call.

| Metric | Meaning |
|---|---|
| `model_selection_accuracy_at_1` | overall + `per_tool`: did the model's forced pick match `expected_tool`? |
| `unparseable_rate` | share of replies that were not an exact registered tool name — scored as incorrect, never as a harness error |
| `confusions` | directed `expected -> predicted` pairs, `unparseable` used as the predicted label when the reply didn't parse |
| `proxy_model_agreement` | how often the model's pick matches the deterministic proxy's pick, computed by reusing `tool-selection.mjs`'s own `rankTools` — only when the tool-selection embeddings fixture is present and valid; absent or corrupt skips this section with a clear note, never a failure |
| `served_model` / `served_model_varied` | the response body's actual `model` field (first observed value) and whether it varied across calls — provenance for the requested alias, since e.g. `gpt-4o-mini` floats to whatever the provider currently points it at |
| `n` / `n_answered` / `gateway_error_count` | a per-scenario gateway failure (timeout, non-OK response) is caught, not propagated, and recorded as its own pick class — excluded from `model_selection_accuracy_at_1` / `unparseable_rate` (those are model-behavior metrics) rather than discarding the whole run; `n_answered` is the explicit denominator both rates use |
| `capability_slice` | report-only, keyed `expected_tool#capability` (e.g. `get_memories#provenance`): the model's `accuracy_at_1`, `unparseable_rate`, `confusions` and counts on those utterances, plus `proxy_accuracy_at_1` (the same number the gate's capability slice prints) and `proxy_model_agreement` when the embeddings fixture is valid. No `per_tool`: each key has one expected tool. Absent when the fixture has no capability scenarios |

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
