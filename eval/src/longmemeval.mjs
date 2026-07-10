// SPDX-License-Identifier: Apache-2.0
// LongMemEval advisory eval.
//
// ADVISORY ONLY — this harness never gates a PR. The blocking golden-set gate
// lives in run.mjs and is untouched. The nightly workflow (eval-nightly.yml)
// runs this and opens/updates an issue on regression; it does not block merges.
//
// Default path is the deterministic retrieval-oracle: zero deps, no network, no
// models. It mirrors the LongMemEval-S schema (haystack_sessions with
// has_answer-flagged turns + answer_session_ids gold labels) and measures
// whether a memory store would surface the answer-bearing session(s). Retrieval
// goes through a PLUGGABLE retriever (retriever.mjs): the deterministic lexical
// (token-overlap) ranker is the DEFAULT and the only path PR-lane tests touch.
//
// --retriever=real (or EVAL_RETRIEVER=real) opts into the REAL Phase-1B
// retriever (#77/#118): it seeds each haystack session as memory via the
// product write path (core.remember + real embedding gateway) and ranks
// sessions by core.search(). It is the NIGHTLY advisory lane only — it needs the
// DB branch + the LLM_GATEWAY_API_KEY secret, and SKIPS cleanly (clear log,
// exit 0) when either is absent.
//
// Slices:
//   --download : fetch + verify the full 500q LongMemEval-S haystack into a
//                gitignored cache (download.mjs) and run the oracle over it.
//                The dataset is large + upstream-licensed and is NEVER
//                committed (root .gitignore: eval/.cache/).
//   --judge    : model-judged answer-synthesis slice (judge.mjs). Offline/PR-CI
//                uses a deterministic fake gateway; the nightly lane uses a live
//                gateway ONLY when LLM_GATEWAY_API_KEY is set (skip-when-absent).
//
// Usage:
//   node eval/src/longmemeval.mjs [--fixture longmemeval-s-subset] [--k 5] [--json]
//   node eval/src/longmemeval.mjs --retriever real [--fixture …] [--k 5] [--json]
//   node eval/src/longmemeval.mjs --download [--force] [--k 5] [--json]
//   node eval/src/longmemeval.mjs --judge [--fixture …] [--k 5] [--json]
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDataset } from './download.mjs'
import {
  createFakeJudgeGateway,
  createGatewayFromEnv,
  GATEWAY_API_KEY_ENV,
  runJudge,
} from './judge.mjs'
import { normalizeQuestions, parseFlag, scoreRanked } from './lib.mjs'
import {
  assertKnownRetriever,
  lexicalRetriever,
  resolveRetriever,
  resolveRetrieverName,
} from './retriever.mjs'

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
 * Retrieval-oracle: recall@k / MRR over gold session labels, scored through the
 * injected `retriever` (lexical default, or the real Phase-1B retriever). The
 * lexical retriever reproduces the pre-swap ranking exactly, so the default
 * output is byte-identical to the prior harness (regression guard).
 */
async function runOracle(dataset, { k, fixture, retriever }) {
  const questions = normalizeQuestions(dataset)
  let recallHits = 0
  let mrrSum = 0
  const perType = {}
  for (const q of questions) {
    const ranked = await retriever.rankSessions(q.question, q.haystack_sessions)
    const { hit, rr } = scoreRanked(ranked, q.answer_session_ids, k)
    if (hit) recallHits++
    mrrSum += rr
    perType[q.question_type] ??= { n: 0, hits: 0 }
    perType[q.question_type].n++
    if (hit) perType[q.question_type].hits++
  }
  const n = questions.length || 1
  return {
    harness: 'longmemeval-advisory',
    tier: 'advisory',
    fixture,
    k,
    questions: questions.length,
    metrics: {
      [`session_recall_at_${k}`]: +(recallHits / n).toFixed(4),
      session_mrr: +(mrrSum / n).toFixed(4),
    },
    by_question_type: Object.fromEntries(
      Object.entries(perType).map(([t, v]) => [t, +(v.hits / v.n).toFixed(4)]),
    ),
  }
}

const k = Number(flag('k', '5'))
const retrieverName = resolveRetrieverName(flag('retriever', undefined))

/**
 * Resolve the oracle retriever. The real retriever may SKIP (DB/secret absent):
 * we exit 0 with a clear log so the nightly lane never fails on a missing
 * dependency. The byte-identical lexical-default contract: when no --retriever
 * is passed and EVAL_RETRIEVER is unset, this returns the pure lexical ranker.
 */
async function resolveOracleRetriever() {
  assertKnownRetriever(retrieverName)
  if (retrieverName === 'lexical') {
    process.stderr.write('retriever: lexical (offline default)\n')
    return lexicalRetriever
  }
  const { retriever, skipReason } = await resolveRetriever(retrieverName)
  if (!retriever) {
    process.stderr.write(
      `--retriever=${retrieverName}: SKIP — ${skipReason}. Advisory only; exiting 0.\n`,
    )
    process.exit(0)
  }
  process.stderr.write('retriever: real (db-backed)\n')
  return retriever
}

if (args.includes('--download')) {
  const { path, cached, bytes, sha256, url } = await ensureDataset({
    force: args.includes('--force'),
  })
  process.stderr.write(
    `dataset ${cached ? 'cached' : 'downloaded'} (${bytes} bytes${sha256 ? `, sha256 ${sha256}` : ''}) from ${url}\n`,
  )
  const dataset = JSON.parse(readFileSync(path, 'utf8'))
  const retriever = await resolveOracleRetriever()
  emit({
    ...(await runOracle(dataset, { k, fixture: 'longmemeval-s-500q', retriever })),
    source: 'download',
  })
} else if (args.includes('--judge')) {
  const fixtureName = flag('fixture', 'longmemeval-s-subset')
  const dataset = loadFixture(fixtureName)
  let gateway = createGatewayFromEnv()
  let mode = 'live'
  if (!gateway) {
    process.stderr.write(
      `--judge: ${GATEWAY_API_KEY_ENV} not set; using deterministic fake gateway (no live model).\n`,
    )
    const golds = new Map(normalizeQuestions(dataset).map((q) => [q.question, q.answer]))
    gateway = createFakeJudgeGateway(golds)
    mode = 'fake'
  }
  const result = await runJudge(dataset, gateway, { k, fixture: fixtureName })
  emit({ ...result, gateway: mode })
} else {
  const fixtureName = flag('fixture', 'longmemeval-s-subset')
  const dataset = loadFixture(fixtureName)
  const retriever = await resolveOracleRetriever()
  emit(await runOracle(dataset, { k, fixture: fixtureName, retriever }))
}
