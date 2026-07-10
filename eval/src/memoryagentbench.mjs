// SPDX-License-Identifier: Apache-2.0
// MemoryAgentBench (MAB) advisory eval.
//
// ADVISORY ONLY — this harness never gates a PR. The blocking golden-set gate
// lives in run.mjs and is untouched. The nightly workflow (eval-nightly.yml)
// runs this; failures open/update a tracking issue and report via STEP_SUMMARY.
// It never blocks merges (≥4 weeks of stability before any blocking
// consideration).
//
// MAB measures two subsets — Conflict Resolution (detect + overwrite
// outdated facts so only the newest valid value is returned) and Test-Time
// Learning (ingest a user-supplied rule/label mid-dialogue, then apply it). The
// metric SHAPE DIFFERS from LongMemEval: it is ACCURACY-OVER-TURNS (did the
// agent answer correctly after ingesting the turns), NOT session_recall@k / MRR.
// So this emits a NEW per-run JSON metrics shape (accuracy per subset + overall)
// rather than the LongMemEval oracle output.
//
// Default path is the deterministic, zero-dep, offline accuracy oracle:
//   - rank the haystack sessions by lexical token-overlap with the question
//     (lib.rankSessions — the same swappable stand-in the LongMemEval oracle
//     uses; swap for the real Phase-1B retriever when it lands),
//   - extract the predicted answer text from the answer-bearing turns of the
//     best-ranked session,
//   - mark the question correct iff the gold answer is contained in that text.
// Conflict Resolution is scored against the NEWEST answer-bearing session
// (answer_session_ids), so returning a superseded value is a miss by
// construction — exactly the contradiction-handling signal the subset exists
// for.
//
// Slices:
//   (default)   : deterministic offline accuracy oracle over the synthetic,
//                 license-clean subset fixture (memoryagentbench-subset.json).
//   --download  : fetch + integrity-verify the OFFICIAL upstream subset parquet
//                 files (Conflict Resolution + Test-Time Learning) into a
//                 gitignored cache (download.mjs ensureMemoryAgentBenchSubset).
//                 Parquet DECODING is DEFERRED (no parquet dependency added this
//                 batch — single lockfile slot is owned by another track); the
//                 lane verifies the pinned url + sha256 + bytes and reports the
//                 integrity result without running the oracle over the decoded
//                 rows. Wire decoding in a follow-up once a vendored/zero-dep
//                 parquet reader (or a dependency budget) is available.
//
// Usage:
//   node eval/src/memoryagentbench.mjs [--fixture memoryagentbench-subset] [--json]
//   node eval/src/memoryagentbench.mjs --download [--subset conflict-resolution] [--force] [--json]
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureMemoryAgentBenchSubset, MAB_SUBSETS } from './download.mjs'
import { parseFlag, rankSessions } from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../fixtures')
const args = process.argv.slice(2)

const flag = (name, fallback) => parseFlag(args, name, fallback)
const asJson = args.includes('--json')

function emit(result) {
  process.stdout.write(`${JSON.stringify(result, null, asJson ? 0 : 2)}\n`)
}

function loadFixture(name) {
  const path = join(fixtures, `${name}.json`)
  if (!existsSync(path)) {
    process.stderr.write(`fixture not found: ${path}\n`)
    process.exit(2)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Concatenated text of a session's answer-bearing turns (has_answer === true).
 * This is the agent's evidence window: the offline oracle "answers" from the
 * best-ranked session's answer-bearing content, never from the full haystack.
 */
function answerEvidence(session) {
  const flagged = session.turns.filter((t) => t.has_answer)
  return (flagged.length > 0 ? flagged : session.turns).map((t) => t.content).join(' ')
}

/** Case/whitespace-insensitive containment: does `text` contain `answer`? */
function containsAnswer(text, answer) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  return norm(text).includes(norm(answer))
}

/**
 * Deterministic accuracy-over-turns oracle for one instance. Ranks sessions by
 * the injected `rank` fn (lexical default), extracts the predicted answer from
 * the top-ranked session's answer-bearing turns, and scores a hit iff the gold
 * answer is contained there AND (when the instance declares answer_session_ids)
 * the top-ranked session is one of the gold answer-bearing sessions. The
 * answer_session_ids guard is what gives Conflict Resolution its semantics: a
 * stale/distractor session that out-ranks the true answer session but still
 * mentions the gold string is a MISS, not a false hit. Returns
 * { correct, predictedSessionId }.
 */
function scoreInstance(instance, rank) {
  const ranked = rank(instance.question, instance.haystack_sessions)
  const top = ranked[0]
  if (!top) return { correct: false, predictedSessionId: null }
  const session = instance.haystack_sessions.find((s) => s.session_id === top.session_id)
  const evidence = session ? answerEvidence(session) : ''
  const answerSessionIds = instance.answer_session_ids
  const inGoldSession =
    !Array.isArray(answerSessionIds) || answerSessionIds.includes(top.session_id)
  return {
    correct: inGoldSession && containsAnswer(evidence, instance.answer),
    predictedSessionId: top.session_id,
  }
}

/**
 * Run the accuracy oracle over a MAB-shaped dataset. Emits the NEW MAB metrics
 * shape: overall accuracy plus per-subset accuracy (conflict-resolution /
 * test-time-learning). IDs/counts/scores ONLY — never haystack content
 * (hard rule 6): the emitted object carries no turn text.
 */
function runAccuracyOracle(dataset, { fixture, rank }) {
  const instances = dataset.instances ?? []
  const perSubset = {}
  let correctTotal = 0
  for (const inst of instances) {
    const subset = inst.subset ?? 'unknown'
    perSubset[subset] ??= { n: 0, correct: 0 }
    perSubset[subset].n++
    const { correct } = scoreInstance(inst, rank)
    if (correct) {
      correctTotal++
      perSubset[subset].correct++
    }
  }
  const n = instances.length || 1
  return {
    harness: 'memoryagentbench-advisory',
    tier: 'advisory',
    fixture,
    subsets: MAB_SUBSETS,
    instances: instances.length,
    metrics: {
      accuracy: +(correctTotal / n).toFixed(4),
    },
    by_subset: Object.fromEntries(
      Object.entries(perSubset).map(([s, v]) => [
        s,
        { instances: v.n, accuracy: +(v.correct / (v.n || 1)).toFixed(4) },
      ]),
    ),
  }
}

/**
 * MAB lexical stand-in: rank sessions by token-overlap (lib.rankSessions, shared
 * with the LongMemEval oracle so swapping in the real Phase-1B retriever (#77)
 * is the same one-line change), then break ties by RECENCY — newest
 * `session_date` first. Recency tie-breaking is the Conflict Resolution
 * semantic: when an old and a new session mention the same fact with equal
 * lexical overlap, the agent must return the NEWEST value, not the stale one.
 * (The LongMemEval oracle breaks ties by session_id; MAB cannot, or it would
 * systematically return superseded values and score CR near zero by
 * construction.) When `session_date` is absent, falls back to the lexical
 * ranker's session_id ordering.
 */
function lexicalRank(question, sessions) {
  const dateById = new Map(sessions.map((s) => [s.session_id, s.session_date ?? '']))
  return rankSessions(question, sessions).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const da = dateById.get(a.session_id) ?? ''
    const db = dateById.get(b.session_id) ?? ''
    if (da !== db) return db.localeCompare(da) // newer date first
    return a.session_id.localeCompare(b.session_id) // stable final tiebreak
  })
}

/**
 * Default CLI harness. Kept behind a direct-execution guard so importing this
 * module (for unit tests / helper reuse of the exported oracle fns) stays
 * side-effect-free: no metrics JSON on stdout, no process.exit(2) from a
 * missing fixture killing the importing process.
 */
async function main() {
  if (args.includes('--download')) {
    const subset = flag('subset', undefined)
    const targets = subset ? [subset] : MAB_SUBSETS
    for (const name of targets) {
      if (!MAB_SUBSETS.includes(name)) {
        process.stderr.write(`unknown MAB subset: ${name} (known: ${MAB_SUBSETS.join(', ')})\n`)
        process.exit(2)
      }
      const { path, cached, bytes, sha256, url } = await ensureMemoryAgentBenchSubset(name, {
        force: args.includes('--force'),
      })
      process.stderr.write(
        `mab ${name} ${cached ? 'cached' : 'downloaded'} (${bytes} bytes${sha256 ? `, sha256 ${sha256}` : ''}) from ${url}\n`,
      )
      // Parquet decoding is DEFERRED (no parquet dep this batch). Emit the
      // content-free integrity result so the nightly lane records that the
      // pinned upstream subset verified, without decoding rows.
      emit({
        harness: 'memoryagentbench-advisory',
        tier: 'advisory',
        subset: name,
        source: 'download',
        decoded: false,
        defer_reason: 'parquet decoding deferred (no parquet dependency this batch)',
        bytes,
        sha256,
        path,
      })
    }
  } else {
    const fixtureName = flag('fixture', 'memoryagentbench-subset')
    const dataset = loadFixture(fixtureName)
    emit(runAccuracyOracle(dataset, { fixture: fixtureName, rank: lexicalRank }))
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}

export { answerEvidence, containsAnswer, runAccuracyOracle, scoreInstance }
