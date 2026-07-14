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

test('empty-string env vars fall back to defaults (GH unset vars.*)', async () => {
  // GitHub Actions exports an unset `vars.*` as '' (not unset). Without
  // normalization, `??` keeps '' so the URL becomes fetch('') and the empty
  // bytes string forces a phantom size mismatch. Assert the defaults hold.
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
    // No pinned integrity (all env empty) -> download succeeds, no phantom
    // size mismatch, and the documented HuggingFace default URL is used.
    const res = await ensureDataset({}, { fetch: fetchImpl, cacheDir: localDir })
    assert.equal(res.cached, false)
    assert.equal(res.bytes, BYTES)
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
])

test('--download lane runs the oracle and emits content-free metrics (#37/#172)', async () => {
  // Hermetic, no network: seed the verified cache so ensureDataset reuses it
  // (idempotent path) instead of fetching upstream. The lane in eval-nightly.yml
  // is identical apart from doing the initial fetch. A pre-existing real cache is
  // saved and restored so a developer's downloaded 500q dataset is never lost.
  const cachedFile = join(CACHE_DIR, DATASET_FILENAME)
  const previousCache = await readFile(cachedFile).catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(cachedFile, OFFICIAL_DATASET)
    const out = execFileSync('node', [cli, '--download', '--json'], { encoding: 'utf8' })
    const result = JSON.parse(out.trim())

    assert.equal(result.source, 'download', 'lane must tag its provenance')
    assert.equal(result.fixture, 'longmemeval-s-500q')
    assert.equal(result.questions, 1)
    assert.equal(result.metrics.session_recall_at_5, 1)
    assert.equal(result.metrics.session_mrr, 1)

    // Hard rule 6: the uploaded artifact carries ids/counts/scores ONLY. No
    // haystack/memory content may appear anywhere in the serialized metrics.
    assert.equal(
      out.includes(CONTENT_SENTINEL),
      false,
      'metrics JSON must never contain haystack/memory content',
    )
    assert.equal(out.includes('wombat'), false)
  } finally {
    await rm(cachedFile, { force: true })
    if (previousCache !== undefined) await writeFile(cachedFile, previousCache)
  }
})
