// SPDX-License-Identifier: Apache-2.0
// Offline unit tests for the --download integrity/idempotency plumbing (#37) and
// the full-500q --download oracle lane wired into eval-nightly.yml.
// No external network: fetch is injected for the unit tests; the lane test
// serves the dataset from a loopback HTTP server (no upstream dependency).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CACHE_DIR,
  DATASET_FILENAME,
  DEFAULT_BYTES,
  ensureDataset,
  hashFile,
  verifyFile,
} from '../src/download.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '../src/longmemeval.mjs')

const PAYLOAD = '[{"question_id":"q1","question":"hi","answer_session_ids":["s1"]}]'
const SHA256 = createHash('sha256').update(PAYLOAD).digest('hex')
const BYTES = Buffer.byteLength(PAYLOAD)

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
  dir = await mkdtemp(join(tmpdir(), 'lme-dl-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('downloads, verifies size+hash, and writes the dataset', async () => {
  let fetched = 0
  const fetchImpl = (...a) => {
    fetched++
    return fakeFetch(PAYLOAD)(...a)
  }
  const res = await ensureDataset(
    { sha256: SHA256, bytes: BYTES },
    { fetch: fetchImpl, cacheDir: dir },
  )
  assert.equal(fetched, 1)
  assert.equal(res.cached, false)
  assert.equal(res.bytes, BYTES)
  assert.equal(res.sha256, SHA256)
  assert.equal(await readFile(join(dir, DATASET_FILENAME), 'utf8'), PAYLOAD)
})

test('re-run reuses the verified cache (idempotent, no re-download)', async () => {
  let fetched = 0
  const fetchImpl = (...a) => {
    fetched++
    return fakeFetch(PAYLOAD)(...a)
  }
  const res = await ensureDataset(
    { sha256: SHA256, bytes: BYTES },
    { fetch: fetchImpl, cacheDir: dir },
  )
  assert.equal(fetched, 0, 'must not re-download a verified cache')
  assert.equal(res.cached, true)
})

test('rejects a size mismatch and does not commit the bad file', async () => {
  const localDir = await mkdtemp(join(tmpdir(), 'lme-bad-'))
  try {
    await assert.rejects(
      ensureDataset(
        { sha256: SHA256, bytes: BYTES + 1 },
        { fetch: fakeFetch(PAYLOAD), cacheDir: localDir },
      ),
      /integrity check failed/,
    )
    await assert.rejects(readFile(join(localDir, DATASET_FILENAME)), /ENOENT/)
  } finally {
    await rm(localDir, { recursive: true, force: true })
  }
})

test('rejects a hash mismatch', async () => {
  const localDir = await mkdtemp(join(tmpdir(), 'lme-hash-'))
  try {
    await assert.rejects(
      ensureDataset(
        { sha256: 'deadbeef', bytes: BYTES },
        { fetch: fakeFetch(PAYLOAD), cacheDir: localDir },
      ),
      /integrity check failed/,
    )
  } finally {
    await rm(localDir, { recursive: true, force: true })
  }
})

test('surfaces a non-ok HTTP status', async () => {
  const localDir = await mkdtemp(join(tmpdir(), 'lme-404-'))
  try {
    await assert.rejects(
      ensureDataset({}, { fetch: fakeFetch('', { ok: false, status: 404 }), cacheDir: localDir }),
      /download failed: 404/,
    )
  } finally {
    await rm(localDir, { recursive: true, force: true })
  }
})

test('empty-string env vars fall back to the pinned defaults (GH unset vars.*)', async () => {
  // GitHub Actions exports an unset `vars.*` as '' (not unset). Without
  // normalization, `??` keeps '' so the URL becomes fetch('') and the empty
  // bytes string forces a phantom size mismatch. Assert the defaults hold: the
  // HuggingFace URL, and the PINNED release (#449), which this small payload is
  // not, so the download is refused rather than silently scored.
  const localDir = await mkdtemp(join(tmpdir(), 'lme-env-'))
  const saved = {
    url: process.env.LONGMEMEVAL_S_URL,
    sha256: process.env.LONGMEMEVAL_S_SHA256,
    bytes: process.env.LONGMEMEVAL_S_BYTES,
  }
  process.env.LONGMEMEVAL_S_URL = ''
  process.env.LONGMEMEVAL_S_SHA256 = ''
  process.env.LONGMEMEVAL_S_BYTES = ''
  try {
    let seenUrl
    const fetchImpl = (u) => {
      seenUrl = u
      return fakeFetch(PAYLOAD)()
    }
    // All env empty -> the documented default URL and the pinned size apply.
    await assert.rejects(
      ensureDataset({}, { fetch: fetchImpl, cacheDir: localDir }),
      new RegExp(`integrity check failed \\(size mismatch: ${BYTES} != ${DEFAULT_BYTES}\\)`),
    )
    assert.match(seenUrl, /huggingface\.co\/datasets\/xiaowu0162\/longmemeval/)
  } finally {
    for (const [k, v] of [
      ['LONGMEMEVAL_S_URL', saved.url],
      ['LONGMEMEVAL_S_SHA256', saved.sha256],
      ['LONGMEMEVAL_S_BYTES', saved.bytes],
    ]) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(localDir, { recursive: true, force: true })
  }
})

test('verifyFile reports missing, size, hash dimensions', async () => {
  const localDir = await mkdtemp(join(tmpdir(), 'lme-vf-'))
  try {
    const path = join(localDir, 'x.json')
    assert.equal((await verifyFile(path)).reason, 'missing')
    await writeFile(path, PAYLOAD)
    assert.equal(await hashFile(path), SHA256)
    assert.equal((await verifyFile(path, { sha256: SHA256, bytes: BYTES })).ok, true)
    assert.equal((await verifyFile(path, { bytes: 1 })).ok, false)
    assert.equal((await verifyFile(path, { sha256: 'nope' })).ok, false)
    // Unpinned metadata: a first run still succeeds and reports observed values.
    const unpinned = await verifyFile(path)
    assert.equal(unpinned.ok, true)
    assert.equal(unpinned.bytes, BYTES)
  } finally {
    await rm(localDir, { recursive: true, force: true })
  }
})

// --- Full-500q --download oracle lane (eval-nightly.yml slice 4, #37) --------
// A sentinel only ever present in haystack TURN CONTENT — never in any id,
// count, score, or question-type. Its absence from the emitted metrics JSON is
// the hard-rule-6 guard (no memory content in the uploaded artifact).
const CONTENT_SENTINEL = 'SECRET_HAYSTACK_CONTENT_apricot_42'

// Minimal OFFICIAL-shape LongMemEval instance (top-level array; parallel
// haystack_session_ids + haystack_sessions of turn-arrays). The gold session
// shares the lexically distinctive token `quokka` with the question, so the
// deterministic oracle ranks it first (recall@5 = 1, mrr = 1).
const OFFICIAL_DATASET = JSON.stringify([
  {
    question_id: 'q1',
    question_type: 'single-session-user',
    question: 'what about the quokka project',
    answer: 'shipped',
    haystack_session_ids: ['s_gold', 's_noise'],
    haystack_sessions: [
      [{ role: 'user', content: `the quokka project ${CONTENT_SENTINEL} shipped` }],
      [{ role: 'user', content: 'unrelated wombat chatter' }],
    ],
    answer_session_ids: ['s_gold'],
  },
  // Abstention: LongMemEval's retrieval protocol skips it. Its question matches
  // s_gold but its listed session is s_noise, so scoring it would pull MRR to
  // 0.75; the lane must report it as skipped instead.
  {
    question_id: 'q2_abs',
    question_type: 'multi-session',
    question: 'what about the quokka launch party',
    answer: 'not mentioned',
    haystack_session_ids: ['s_gold', 's_noise'],
    haystack_sessions: [
      [{ role: 'user', content: `the quokka project ${CONTENT_SENTINEL} shipped` }],
      [{ role: 'user', content: 'unrelated wombat chatter' }],
    ],
    answer_session_ids: ['s_noise'],
  },
])

// The cache is pinned to the real release, so the hermetic lane tests pin the
// seeded dataset through the env override instead (never a network fetch).
const envFor = (dataset) => ({
  ...process.env,
  LONGMEMEVAL_S_SHA256: createHash('sha256').update(dataset).digest('hex'),
  LONGMEMEVAL_S_BYTES: String(Buffer.byteLength(dataset)),
})
const OFFICIAL_ENV = envFor(OFFICIAL_DATASET)

/**
 * Seed the verified cache with OFFICIAL_DATASET, run `fn`, then restore a
 * pre-existing real cache so a developer's downloaded 500q dataset is never lost.
 */
async function withSeededCache(fn, dataset = OFFICIAL_DATASET) {
  const cachedFile = join(CACHE_DIR, DATASET_FILENAME)
  const previousCache = await readFile(cachedFile).catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(cachedFile, dataset)
    await fn()
  } finally {
    await rm(cachedFile, { force: true })
    if (previousCache !== undefined) await writeFile(cachedFile, previousCache)
  }
}

test('--download lane runs the oracle and emits content-free metrics (#37/#172)', async () => {
  // Hermetic, no network: seed the verified cache so ensureDataset reuses it
  // (idempotent path) instead of fetching upstream. The lane in eval-nightly.yml
  // is identical apart from doing the initial fetch.
  await withSeededCache(() => {
    const out = execFileSync('node', [cli, '--download', '--json'], {
      encoding: 'utf8',
      env: OFFICIAL_ENV,
    })
    const result = JSON.parse(out.trim())

    assert.equal(result.source, 'download', 'lane must tag its provenance')
    assert.equal(result.fixture, 'longmemeval-s-500q')
    assert.equal(result.retriever, 'lexical')
    assert.equal(result.questions, 2)
    assert.equal(result.retrieval_scored, 1)
    assert.equal(result.abstention_skipped, 1)
    assert.equal(result.protocol, 'answer-ids', 'the default protocol is named')
    assert.equal(result.no_target_skipped, undefined)
    assert.equal(result.metrics.session_recall_at_5, 1)
    assert.equal(result.metrics.session_mrr, 1, 'the abstention question is not scored')
    assert.deepEqual(result.by_question_type, { 'single-session-user': 1 })
    // Per-ability rows carry their own n; a lexical run has no baseline block.
    assert.deepEqual(result.by_ability, {
      'information-extraction': {
        n: 1,
        session_recall_at_5: 1,
        session_mrr: 1,
        session_recall_all_at_5: 1,
        session_ndcg_any_at_5: 1,
        session_recall_all_at_10: 1,
        session_ndcg_any_at_10: 1,
      },
    })
    assert.equal(result.lexical_baseline, undefined)

    // Hard rule 6: the uploaded artifact carries ids/counts/scores ONLY. No
    // haystack/memory content may appear anywhere in the serialized metrics.
    assert.equal(
      out.includes(CONTENT_SENTINEL),
      false,
      'metrics JSON must never contain haystack/memory content',
    )
    assert.equal(out.includes('wombat'), false)
  })
})

/** Write a sample file for OFFICIAL_DATASET to a temp dir; never into eval/fixtures. */
async function writeSample(overrides = {}) {
  const sample = {
    dataset: { name: 'longmemeval_s', sha256: OFFICIAL_ENV.LONGMEMEVAL_S_SHA256 },
    question_ids: ['q1'],
    ...overrides,
  }
  const path = join(dir, `sample-${Math.random().toString(36).slice(2)}.json`)
  await writeFile(path, JSON.stringify(sample))
  return path
}

test('--download --sample scores only the sampled ids, content-free (#449)', async () => {
  await withSeededCache(async () => {
    const samplePath = await writeSample()
    const out = execFileSync('node', [cli, '--download', '--sample', samplePath, '--json'], {
      encoding: 'utf8',
      env: OFFICIAL_ENV,
    })
    const result = JSON.parse(out.trim())
    assert.equal(result.sample, samplePath)
    assert.equal(result.questions, 1)
    assert.equal(result.metrics.session_recall_at_5, 1)
    assert.equal(out.includes(CONTENT_SENTINEL), false)
  })
})

test('--sample refuses a different release or an unknown id with exit 2 (#449)', async () => {
  await withSeededCache(async () => {
    const cases = [
      await writeSample({ dataset: { sha256: 'not-the-scored-release' } }),
      await writeSample({ question_ids: ['q1', 'q_missing'] }),
      // Abstention only: nothing to score for retrieval, so no zeros either.
      await writeSample({ question_ids: ['q2_abs'] }),
    ]
    for (const samplePath of cases) {
      assert.throws(
        () =>
          execFileSync('node', [cli, '--download', '--sample', samplePath, '--json'], {
            encoding: 'utf8',
            env: OFFICIAL_ENV,
            stdio: 'pipe',
          }),
        (error) => error.status === 2 && error.stdout === '',
      )
    }
  })
})

test('--sample without --download exits 2 before any scoring (#449)', () => {
  assert.throws(
    () =>
      execFileSync('node', [cli, '--sample', 'longmemeval-s-sample-50'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    (error) => error.status === 2 && /needs --download/.test(error.stderr),
  )
})

// Upstream-shaped ids and has_answer flags (#516): u1's second listed session
// is flagged only on an assistant turn, so it is not upstream gold; u2's only
// evidence is an assistant turn, so upstream skips the question.
const UPSTREAM_SHAPED = JSON.stringify([
  {
    question_id: 'u1',
    question_type: 'single-session-user',
    question: 'what about the quokka project',
    haystack_session_ids: ['answer_u1_1', 's_noise', 'answer_u1_2'],
    haystack_sessions: [
      [{ role: 'user', content: `the quokka project ${CONTENT_SENTINEL}`, has_answer: true }],
      [{ role: 'user', content: 'unrelated wombat chatter', has_answer: false }],
      [
        { role: 'user', content: 'quokka', has_answer: false },
        { role: 'assistant', content: 'noted', has_answer: true },
      ],
    ],
    answer_session_ids: ['answer_u1_1', 'answer_u1_2'],
  },
  {
    question_id: 'u2',
    question_type: 'single-session-assistant',
    question: 'what did you say about the quokka',
    haystack_session_ids: ['answer_u2_1', 's_noise'],
    haystack_sessions: [
      [
        { role: 'user', content: 'tell me', has_answer: false },
        { role: 'assistant', content: 'the quokka note', has_answer: true },
      ],
      [{ role: 'user', content: 'unrelated wombat chatter', has_answer: false }],
    ],
    answer_session_ids: ['answer_u2_1'],
  },
  {
    question_id: 'u3_abs',
    question_type: 'multi-session',
    question: 'what about the quokka party',
    haystack_session_ids: ['s_noise'],
    haystack_sessions: [[{ role: 'user', content: 'wombat', has_answer: false }]],
    answer_session_ids: [],
  },
])

test('--protocol upstream applies its gold and skip rules and counts the skips (#516)', async () => {
  await withSeededCache(() => {
    const run = (protocol) =>
      execFileSync('node', [cli, '--download', '--protocol', protocol, '--json'], {
        encoding: 'utf8',
        env: envFor(UPSTREAM_SHAPED),
      })
    const out = run('upstream')
    const upstream = JSON.parse(out.trim())
    assert.equal(upstream.protocol, 'upstream')
    assert.equal(upstream.questions, 3)
    assert.equal(upstream.retrieval_scored, 1)
    assert.equal(upstream.abstention_skipped, 1)
    assert.equal(upstream.no_target_skipped, 1, 'u2 has no flagged user turn')
    assert.equal(upstream.metrics.session_recall_all_at_5, 1)
    assert.equal(out.includes(CONTENT_SENTINEL), false)

    const answerIds = JSON.parse(run('answer-ids').trim())
    assert.equal(answerIds.protocol, 'answer-ids')
    assert.equal(answerIds.retrieval_scored, 2, 'answer-ids scores u2 too')
    assert.equal(answerIds.no_target_skipped, undefined)
  }, UPSTREAM_SHAPED)
})

test('--protocol refuses an unknown name, nothing to score, or no gold (#516)', async () => {
  const refused = (args, env, pattern) =>
    assert.throws(
      () =>
        execFileSync('node', [cli, ...args, '--json'], { encoding: 'utf8', env, stdio: 'pipe' }),
      (error) => error.status === 2 && error.stdout === '' && pattern.test(error.stderr),
    )
  refused(['--protocol', 'bogus'], process.env, /unknown --protocol 'bogus'/)
  // Bare, or followed by another flag: refused, not scored under the default.
  refused(['--protocol'], process.env, /unknown --protocol ''/)
  refused(['--protocol='], process.env, /unknown --protocol ''/)
  // The synthetic subset flags user turns but has no upstream "answer" ids.
  refused(['--protocol', 'upstream'], process.env, /have no gold session/)
  // The seeded file has no has_answer flags: upstream skips every question.
  await withSeededCache(() =>
    refused(['--download', '--protocol', 'upstream'], OFFICIAL_ENV, /no retrieval-scorable/),
  )
})
