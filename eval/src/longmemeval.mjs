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
//   --sample   : with --download only. Score just the question ids a sample
//                fixture lists (sample.mjs, #449); the sample's recorded
//                dataset sha256 must match the verified download, else exit 2.
//   --judge    : model-judged answer-synthesis slice (judge.mjs). Offline/PR-CI
//                uses a deterministic fake gateway; the nightly lane uses a live
//                gateway ONLY when LLM_GATEWAY_API_KEY is set (skip-when-absent).
//
// --protocol picks the gold and skip rules retrieval is scored under
// (retrieval-metrics.mjs, #516): `answer-ids` (default), `upstream` (the
// released code's averaging) or `paper` (every question, as the paper's
// tables were averaged). The output names it in `protocol`.
//
// --retriever bm25 is LongMemEval's own BM25 baseline (bm25.mjs): offline,
// over the sessions' user turns.
//
// Usage:
//   node eval/src/longmemeval.mjs [--fixture longmemeval-s-subset] [--k 5] [--json]
//   node eval/src/longmemeval.mjs --retriever real [--fixture …] [--k 5] [--json]
//   node eval/src/longmemeval.mjs --download [--force] [--k 5] [--json]
//   node eval/src/longmemeval.mjs --download --sample longmemeval-s-sample-50 [--retriever real]
//   node eval/src/longmemeval.mjs --judge [--fixture …] [--k 5] [--json]
//
// --ranks-out <path> also writes one JSON line per scored question with its
// gold sessions' ranks (ids and numbers only, never text; #517), so a miss can
// be traced to the questions that caused it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDataset } from './download.mjs'
import {
  createFakeJudgeGateway,
  createGatewayFromEnv,
  GATEWAY_API_KEY_ENV,
  runJudge,
} from './judge.mjs'
import {
  ABILITIES,
  abilityOf,
  isAbstention,
  normalizeQuestions,
  parseFlag,
  parsePathFlag,
  scoreRanked,
} from './lib.mjs'
import { PROTOCOLS, upstreamMetrics } from './retrieval-metrics.mjs'
import {
  assertKnownRetriever,
  lexicalRetriever,
  resolveRetriever,
  resolveRetrieverName,
} from './retriever.mjs'
import { applySample } from './sample.mjs'

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

/** A running total of one question set's scores; `sums` holds upstream's metrics. */
function tally(into, { hit, rr, extra }) {
  into.n++
  if (hit) into.hits++
  into.rr += rr
  for (const [key, value] of Object.entries(extra)) into.sums[key] = (into.sums[key] ?? 0) + value
}

const newTally = () => ({ n: 0, hits: 0, rr: 0, sums: {} })
const rate = (sum, n) => +(sum / (n || 1)).toFixed(4)

/** Mean of every metric in a tally: today's any-recall and MRR first, then upstream's. */
function rates({ n, hits, rr, sums }, k) {
  return {
    [`session_recall_at_${k}`]: rate(hits, n),
    session_mrr: rate(rr, n),
    ...Object.fromEntries(Object.entries(sums).map(([key, sum]) => [key, rate(sum, n)])),
  }
}

/**
 * Per-ability rows in LongMemEval's report order, each with its own `n`: a
 * 50-question sample has 5 to 15 questions per ability, so one hit moves a row
 * by several points and the count must travel with the rate.
 */
function abilityRows(perAbility, k) {
  const order = [...ABILITIES, ...Object.keys(perAbility).filter((a) => !ABILITIES.includes(a))]
  return Object.fromEntries(
    order
      .filter((ability) => perAbility[ability])
      .map((ability) => [ability, { n: perAbility[ability].n, ...rates(perAbility[ability], k) }]),
  )
}

/**
 * The questions retrieval is scored on. LongMemEval's own retrieval protocol
 * always skips the abstention (`_abs`) questions: they ask about events that
 * never happened, so they have no ground-truth answer location (upstream
 * README, "Memory Retrieval"). Abstention is an answer-level ability, for the
 * judge; it is counted in `abstention_skipped`, never scored as retrieval. The
 * upstream protocol also skips a question with no flagged user turn
 * (`no_target_skipped`).
 */
function retrievalQuestions(questions) {
  return questions.filter(
    (q) => (protocol.scoresAbstention || !isAbstention(q.question_id)) && protocol.scores(q),
  )
}

/**
 * Retrieval-oracle: any-recall@k and MRR, plus upstream's recall_all and
 * ndcg_any at 5 and 10, over the protocol's gold sessions. Scored through the
 * injected `retriever` (lexical default, or the real Phase-1B retriever) over
 * already-normalized questions. Every metric reads the same ranking, so the
 * extra ones cost no retrieval or embedding call.
 */
/**
 * One question's gold-session ranks, 1-based and ascending; null for a gold
 * session the ranking lacks. Ids and numbers only, never text (hard rule 6).
 */
function goldRanks(q, gold, rankedIds) {
  const position = new Map()
  rankedIds.forEach((id, i) => {
    if (!position.has(id)) position.set(id, i + 1)
  })
  const ranks = gold.map((id) => position.get(id) ?? null)
  return {
    question_id: q.question_id,
    ability: abilityOf(q),
    sessions: rankedIds.length,
    gold_ranks: ranks.sort(
      (a, b) => (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY),
    ),
  }
}

async function runOracle(questions, { k, fixture, retriever, ranks }) {
  const scored = retrievalQuestions(questions)
  const total = newTally()
  const perType = {}
  const perAbility = {}
  for (const q of scored) {
    const ranked = await retriever.rankSessions(q.question, q.haystack_sessions)
    const gold = protocol.gold(q)
    const { hit, rr } = scoreRanked(ranked, gold, k)
    const rankedIds = ranked.map((r) => r.session_id)
    const corpus = q.haystack_sessions.map((s) => s.session_id)
    const score = { hit, rr, extra: upstreamMetrics(rankedIds, gold, corpus) }
    ranks?.push(goldRanks(q, gold, rankedIds))
    tally(total, score)
    perType[q.question_type] ??= { n: 0, hits: 0 }
    perType[q.question_type].n++
    if (hit) perType[q.question_type].hits++
    const ability = abilityOf(q)
    perAbility[ability] ??= newTally()
    tally(perAbility[ability], score)
  }
  const abstention = protocol.scoresAbstention
    ? 0
    : questions.filter((q) => isAbstention(q.question_id)).length
  const emptyGold = protocol.allowsEmptyGold
    ? { empty_gold: scored.filter((q) => protocol.gold(q).length === 0).length }
    : {}
  return {
    harness: 'longmemeval-advisory',
    tier: 'advisory',
    fixture,
    k,
    protocol: protocolName,
    questions: questions.length,
    retrieval_scored: scored.length,
    abstention_skipped: abstention,
    ...(protocolName === 'upstream'
      ? { no_target_skipped: questions.length - abstention - scored.length }
      : {}),
    ...emptyGold,
    retriever: retriever.name,
    metrics: rates(total, k),
    by_question_type: Object.fromEntries(
      Object.entries(perType).map(([t, v]) => [t, +(v.hits / v.n).toFixed(4)]),
    ),
    by_ability: abilityRows(perAbility, k),
  }
}

/**
 * Score with the resolved retriever. A real-retriever run also scores the
 * lexical stand-in on the SAME questions, so the two numbers sit side by side
 * in one artifact instead of being matched up across lanes.
 */
async function scoreQuestions(questions, { fixture, retriever }) {
  let result
  const ranks = ranksOut === undefined ? undefined : []
  try {
    // An embedding cache (#449) prefills in batches first, only for the
    // questions retrieval scores; a partial run still saves what it fetched,
    // so a rerun does not pay for it twice.
    await retriever.prepare?.(retrievalQuestions(questions))
    result = await runOracle(questions, { k, fixture, retriever, ranks })
  } finally {
    retriever.finish?.()
  }
  if (ranks !== undefined) {
    mkdirSync(dirname(ranksOut), { recursive: true })
    writeFileSync(ranksOut, ranks.map((row) => `${JSON.stringify(row)}\n`).join(''))
  }
  // Only the real retriever needs the stand-in beside it; offline ones are baselines themselves.
  if (retriever.name !== 'real') return result
  const cache = retriever.stats?.()
  const baseline = await runOracle(questions, { k, fixture, retriever: lexicalRetriever })
  return {
    ...result,
    ...(cache === undefined ? {} : { embedding_cache: cache }),
    lexical_baseline: { metrics: baseline.metrics, by_ability: baseline.by_ability },
  }
}

/** A sample is a fixture name, or a path to a `.json` sample file (tests use a temp file). */
function loadSample(value) {
  if (!value.endsWith('.json')) return loadFixture(value)
  if (!existsSync(value)) refuse(`sample not found: ${value}`)
  return JSON.parse(readFileSync(value, 'utf8'))
}

/** Exit 2 with a clear reason: a lane that cannot score its questions scores nothing. */
function refuse(message) {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

/**
 * Refuse a run with nothing to score for retrieval (an abstention-only sample,
 * an empty fixture): its zero metrics would read like a result. Checked before
 * the retriever is resolved, so a refused run never touches a DB or gateway.
 */
function assertScorable(questions) {
  const scored = retrievalQuestions(questions)
  if (scored.length === 0) {
    refuse(
      `no retrieval-scorable questions under --protocol ${protocolName}: ${questions.length} given, abstention is skipped`,
    )
  }
  // Upstream's gold rule reads "answer" in the session id. A file without
  // upstream's ids scores every question against an empty gold set, where
  // recall_all is a vacuous 1; refuse instead of reporting that.
  const goldless = scored.filter((q) => protocol.gold(q).length === 0).length
  if (goldless > 0 && !protocol.allowsEmptyGold) {
    refuse(
      `--protocol ${protocolName}: ${goldless} of ${scored.length} questions have no gold session`,
    )
  }
}

const k = Number(flag('k', '5'))
// A bare --protocol (or one followed by another flag) reads as '' and is
// refused, never scored under the default it did not name (as with #122).
const protocolGiven = args.some((a) => a === '--protocol' || a.startsWith('--protocol='))
const protocolName = protocolGiven ? flag('protocol', '') : 'answer-ids'
const protocol = Object.hasOwn(PROTOCOLS, protocolName) ? PROTOCOLS[protocolName] : undefined
if (protocol === undefined) {
  refuse(`unknown --protocol '${protocolName}': expected ${Object.keys(PROTOCOLS).join(' or ')}`)
}
const retrieverName = resolveRetrieverName(flag('retriever', undefined))
let sampleName
try {
  sampleName = parsePathFlag(args, 'sample')
} catch (error) {
  refuse(error.message)
}
let ranksOut
try {
  ranksOut = parsePathFlag(args, 'ranks-out')
} catch (error) {
  refuse(error.message)
}
if (sampleName !== undefined && !args.includes('--download')) {
  refuse('--sample needs --download: a sample lists ids from the pinned upstream file')
}

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
  process.stderr.write(`retriever: ${retriever.name}\n`)
  return retriever
}

if (args.includes('--download')) {
  const { path, cached, bytes, sha256, url } = await ensureDataset({
    force: args.includes('--force'),
  })
  process.stderr.write(
    `dataset ${cached ? 'cached' : 'downloaded'} (${bytes} bytes${sha256 ? `, sha256 ${sha256}` : ''}) from ${url}\n`,
  )
  let questions = normalizeQuestions(JSON.parse(readFileSync(path, 'utf8')))
  if (sampleName !== undefined) {
    try {
      questions = applySample(questions, loadSample(sampleName), sha256)
    } catch (error) {
      refuse(`--sample ${sampleName}: ${error.message}`)
    }
  }
  assertScorable(questions)
  const retriever = await resolveOracleRetriever()
  emit({
    ...(await scoreQuestions(questions, { fixture: 'longmemeval-s-500q', retriever })),
    ...(sampleName === undefined ? {} : { sample: sampleName }),
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
  const questions = normalizeQuestions(loadFixture(fixtureName))
  assertScorable(questions)
  const retriever = await resolveOracleRetriever()
  emit(await scoreQuestions(questions, { fixture: fixtureName, retriever }))
}
