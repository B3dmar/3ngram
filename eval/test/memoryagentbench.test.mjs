// SPDX-License-Identifier: Apache-2.0
// Offline unit tests for the MemoryAgentBench (MAB) advisory harness (#294):
// the deterministic accuracy-over-turns oracle and the MAB subset --download
// integrity plumbing. No external network: fetch is injected for the download
// tests; the oracle path is pure and offline.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ensureMemoryAgentBenchSubset, MAB_SUBSETS } from '../src/download.mjs'
import {
  answerEvidence,
  containsAnswer,
  runAccuracyOracle,
  scoreInstance,
} from '../src/memoryagentbench.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '../src/memoryagentbench.mjs')

// A recency-tie CR-shaped instance: BOTH sessions match the question lexically,
// but only the NEWER one carries the correct (current) answer. Exercises the
// recency tie-break — an oracle that returned the stale session would miss.
const CR_INSTANCE = {
  instance_id: 'cr_t1',
  subset: 'conflict-resolution',
  question: 'who is the on-call engineer',
  answer: 'Priya',
  answer_session_ids: ['s_new'],
  haystack_sessions: [
    {
      session_id: 's_old',
      session_date: '2026-01-01',
      turns: [{ role: 'user', content: 'the on-call engineer is Marcus', has_answer: true }],
    },
    {
      session_id: 's_new',
      session_date: '2026-05-01',
      turns: [{ role: 'user', content: 'the on-call engineer is now Priya', has_answer: true }],
    },
  ],
}

test('accuracy oracle resolves a conflict to the newest answer-bearing session', () => {
  const out = runAccuracyOracle(
    { instances: [CR_INSTANCE] },
    {
      fixture: 'unit',
      rank: lexicalRankForTest,
    },
  )
  assert.equal(out.metrics.accuracy, 1)
  assert.equal(out.by_subset['conflict-resolution'].accuracy, 1)
  assert.equal(out.harness, 'memoryagentbench-advisory')
  assert.equal(out.tier, 'advisory')
})

// Reproduce the harness's recency-aware lexical rank for the unit test (the
// production rank is internal to the CLI; this asserts the metric math against a
// known-good rank). Token-overlap with newest-date tiebreak.
function lexicalRankForTest(_question, sessions) {
  return [...sessions]
    .map((s) => ({ session_id: s.session_id, date: s.session_date ?? '' }))
    .sort((a, b) =>
      b.date !== a.date ? b.date.localeCompare(a.date) : a.session_id.localeCompare(b.session_id),
    )
}

test('scoreInstance rejects a distractor that out-ranks the gold answer session', () => {
  // A stale/distractor session out-ranks the true answer session AND still
  // mentions the gold string ("Priya is no longer on call"). Containment alone
  // would false-hit; the answer_session_ids guard makes it a miss.
  const inst = {
    subset: 'conflict-resolution',
    question: 'who is on call',
    answer: 'Priya',
    answer_session_ids: ['s_gold'],
    haystack_sessions: [
      {
        session_id: 's_distractor',
        session_date: '2026-05-01',
        turns: [{ role: 'user', content: 'Priya is no longer on call', has_answer: true }],
      },
      {
        session_id: 's_gold',
        session_date: '2026-04-01',
        turns: [{ role: 'user', content: 'on call is Priya', has_answer: true }],
      },
    ],
  }
  // Rank the distractor first to simulate a retriever regression.
  const rank = (_q, ss) => ss.map((s) => ({ session_id: s.session_id }))
  const { correct, predictedSessionId } = scoreInstance(inst, rank)
  assert.equal(predictedSessionId, 's_distractor')
  assert.equal(correct, false)
})

test('answerEvidence prefers has_answer turns; containsAnswer is case-insensitive', () => {
  const session = {
    session_id: 's',
    turns: [
      { role: 'user', content: 'noise', has_answer: false },
      { role: 'user', content: 'the answer is Railway', has_answer: true },
    ],
  }
  assert.equal(answerEvidence(session), 'the answer is Railway')
  assert.equal(containsAnswer('The Answer Is RAILWAY', 'railway'), true)
  assert.equal(containsAnswer('nothing here', 'railway'), false)
})

test('scoreInstance marks a miss when the top session lacks the gold answer', () => {
  const inst = {
    subset: 'conflict-resolution',
    question: 'who is on call',
    answer: 'Priya',
    haystack_sessions: [
      {
        session_id: 's_old',
        session_date: '2026-05-01',
        turns: [{ role: 'user', content: 'on call is Marcus', has_answer: true }],
      },
    ],
  }
  const { correct } = scoreInstance(inst, (_q, ss) => ss.map((s) => ({ session_id: s.session_id })))
  assert.equal(correct, false)
})

test('CLI default offline path scores both subsets advisory-green (no network)', () => {
  const out = execFileSync('node', [cli, '--json'], { encoding: 'utf8' })
  const result = JSON.parse(out.trim())
  assert.equal(result.harness, 'memoryagentbench-advisory')
  assert.equal(result.tier, 'advisory')
  assert.deepEqual(result.subsets, MAB_SUBSETS)
  assert.equal(result.metrics.accuracy, 1)
  assert.equal(result.by_subset['conflict-resolution'].accuracy, 1)
  assert.equal(result.by_subset['test-time-learning'].accuracy, 1)
})

// Hard rule 6: the emitted metrics carry ids/counts/scores ONLY — never haystack
// content. A sentinel only ever present in fixture turn content must not appear
// in the serialized metrics. (The synthetic fixture is content-checked here.)
test('CLI metrics output contains no haystack turn content (hard rule 6)', async () => {
  const out = execFileSync('node', [cli, '--json'], { encoding: 'utf8' })
  const fixture = JSON.parse(
    await readFile(join(here, '../fixtures/memoryagentbench-subset.json'), 'utf8'),
  )
  // Pull a distinctive content token from the fixture and assert it never leaks.
  const sample = fixture.instances[0].haystack_sessions[0].turns[0].content
    .split(' ')
    .find((w) => w.length > 6)
  assert.ok(sample, 'fixture must have a distinctive content token to check')
  assert.equal(out.includes(sample), false, 'metrics JSON must not contain turn content')
})

// --- MAB subset --download integrity plumbing (#294) -------------------------
const PARQUET_BODY = 'PAR1-fake-parquet-bytes-for-test-PAR1'
const SHA256 = createHash('sha256').update(PARQUET_BODY).digest('hex')
const BYTES = Buffer.byteLength(PARQUET_BODY)

function fakeFetch(body, { ok = true, status = 200 } = {}) {
  return () =>
    Promise.resolve({
      ok,
      status,
      statusText: ok ? 'OK' : 'ERR',
      body: ok ? Readable.toWeb(Readable.from([Buffer.from(body)])) : null,
    })
}

let dir
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mab-dl-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('downloads + verifies a MAB subset (size+hash), then reuses cache', async () => {
  let fetched = 0
  const fetchImpl = (...a) => {
    fetched++
    return fakeFetch(PARQUET_BODY)(...a)
  }
  const first = await ensureMemoryAgentBenchSubset(
    'conflict-resolution',
    { sha256: SHA256, bytes: BYTES },
    { fetch: fetchImpl, cacheDir: dir },
  )
  assert.equal(fetched, 1)
  assert.equal(first.cached, false)
  assert.equal(first.subset, 'conflict-resolution')
  assert.equal(first.bytes, BYTES)
  assert.equal(first.sha256, SHA256)

  const second = await ensureMemoryAgentBenchSubset(
    'conflict-resolution',
    { sha256: SHA256, bytes: BYTES },
    { fetch: fetchImpl, cacheDir: dir },
  )
  assert.equal(fetched, 1, 'must not re-download a verified cache')
  assert.equal(second.cached, true)
})

test('MAB subset rejects an integrity mismatch and commits no bad file', async () => {
  const localDir = await mkdtemp(join(tmpdir(), 'mab-bad-'))
  try {
    await assert.rejects(
      ensureMemoryAgentBenchSubset(
        'test-time-learning',
        { sha256: 'deadbeef', bytes: BYTES },
        { fetch: fakeFetch(PARQUET_BODY), cacheDir: localDir },
      ),
      /integrity check failed/,
    )
    await assert.rejects(readFile(join(localDir, 'mab_test_time_learning.parquet')), /ENOENT/)
  } finally {
    await rm(localDir, { recursive: true, force: true })
  }
})

test('MAB subset rejects an unknown subset name', async () => {
  await assert.rejects(
    ensureMemoryAgentBenchSubset(
      'does-not-exist',
      {},
      { fetch: fakeFetch(PARQUET_BODY), cacheDir: dir },
    ),
    /unknown MAB subset/,
  )
})

test('empty-string env overrides fall back to pinned defaults (GH unset vars.*)', async () => {
  // GitHub Actions exports an unset `vars.*` as '' (not unset). Without
  // normalization the pinned url/sha256/bytes would be replaced by '' and the
  // fetch would hit fetch('') with a phantom integrity mismatch. With env '',
  // the PINNED defaults must survive: the fetch must see the pinned HuggingFace
  // URL, and the pinned sha/bytes (not '') must drive verification — so a body
  // that does NOT match the pinned integrity must be REJECTED.
  const localDir = await mkdtemp(join(tmpdir(), 'mab-env-'))
  const keys = [
    'MAB_CONFLICT_RESOLUTION_URL',
    'MAB_CONFLICT_RESOLUTION_SHA256',
    'MAB_CONFLICT_RESOLUTION_BYTES',
  ]
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  for (const k of keys) process.env[k] = ''
  try {
    let seenUrl
    const fetchImpl = (u) => {
      seenUrl = u
      return fakeFetch(PARQUET_BODY)() // != pinned content -> must be rejected
    }
    await assert.rejects(
      ensureMemoryAgentBenchSubset(
        'conflict-resolution',
        {},
        { fetch: fetchImpl, cacheDir: localDir },
      ),
      /integrity check failed/,
      'pinned sha/bytes (not empty env) must drive verification',
    )
    assert.match(seenUrl, /huggingface\.co\/datasets\/ai-hyz\/MemoryAgentBench/)
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    await rm(localDir, { recursive: true, force: true })
  }
})
