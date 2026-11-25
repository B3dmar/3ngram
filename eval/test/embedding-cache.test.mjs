// SPDX-License-Identifier: Apache-2.0
// Offline tests for the content-addressed embedding cache (#449). A counting
// fake stands in for the live gateway: no network, no DB, no model.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createCachingGateway, embeddingKey } from '../src/embedding-cache.mjs'

const MODEL = 'text-embedding-3-large'
const DIMS = 4
const SENTINEL = 'SECRET_MEMORY_TEXT_persimmon_23'

/** Deterministic fake: a text's vector comes from its hash; POISON texts make the batch fail. */
function fakeInner() {
  const calls = []
  return {
    calls,
    embed(texts, operation) {
      calls.push({ texts: [...texts], operation })
      if (texts.some((t) => t.includes('POISON'))) {
        return Promise.reject(new Error('400 from provider'))
      }
      const embeddings = texts.map((t) => {
        const h = createHash('sha256').update(t).digest()
        return Array.from({ length: DIMS }, (_, i) => h[i] / 255 + 0.1)
      })
      return Promise.resolve({ embeddings, usage: { inputTokens: texts.length * 3 }, model: MODEL })
    },
    complete: (prompt) => Promise.resolve({ text: `c:${prompt}` }),
    decide: () => Promise.resolve({ answers: {}, model: 'd' }),
  }
}

let dir
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lme-emb-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})
const fileIn = (name) => join(dir, name)
const open = (inner, file, opts = {}) =>
  createCachingGateway(inner, { file, model: MODEL, dimensions: DIMS, ...opts })

test('a warm run serves every vector from the cache, identical to the cold run', async () => {
  const file = fileIn('warm.jsonl')
  const texts = ['alpha', 'beta', `gamma ${SENTINEL}`]

  const coldInner = fakeInner()
  const cold = open(coldInner, file)
  await cold.prefill([...texts, 'alpha'])
  assert.equal(coldInner.calls.length, 1, 'one batched prefill call for three unique texts')
  const coldVectors = (await cold.embed(texts, 'memory.embed')).embeddings
  assert.equal(coldInner.calls.length, 1, 'embeds after prefill are cache hits')
  cold.save()

  const warmInner = fakeInner()
  const warm = open(warmInner, file)
  const result = await warm.embed(texts, 'memory.embed')
  assert.equal(warmInner.calls.length, 0, 'warm run makes zero live calls')
  assert.deepEqual(result.embeddings, coldVectors)
  assert.equal(result.usage.inputTokens, 0)
  assert.equal(result.model, MODEL)
  assert.deepEqual(warm.stats(), {
    loaded: 3,
    dropped_on_load: 0,
    hits: 3,
    misses: 0,
    live_calls: 0,
    live_input_tokens: 0,
    failed_texts: 0,
    entries: 3,
  })
})

test('served vectors are float32-rounded, in request order, duplicates included', async () => {
  const gateway = open(fakeInner(), fileIn('order.jsonl'))
  const { embeddings } = await gateway.embed(['b', 'a', 'b'], 'search')
  assert.deepEqual(embeddings[0], embeddings[2])
  assert.notDeepEqual(embeddings[0], embeddings[1])
  for (const value of embeddings.flat()) assert.equal(value, Math.fround(value))
})

test('a failed batch is retried one text per call; a failing text is counted, not cached', async () => {
  const inner = fakeInner()
  const gateway = open(inner, fileIn('poison.jsonl'), { batchSize: 2 })
  await gateway.prefill(['ok1', 'POISON one', 'ok2', '   '])
  // [ok1, POISON] fails -> ok1 alone, POISON alone (fails) -> [ok2]; blank text skipped.
  assert.deepEqual(
    inner.calls.map((c) => c.texts),
    [['ok1', 'POISON one'], ['ok1'], ['POISON one'], ['ok2']],
  )
  assert.equal(gateway.stats().failed_texts, 1)
  assert.equal(gateway.stats().entries, 2)
  await assert.rejects(gateway.embed(['POISON one'], 'memory.embed'), /400 from provider/)
})

test('a mismatched header or a corrupt line is dropped and refetched, never served', async () => {
  const file = fileIn('corrupt.jsonl')
  const seed = open(fakeInner(), file)
  await seed.prefill(['keep', 'lose'])
  seed.save()
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
  const lose = embeddingKey(MODEL, DIMS, 'lose')
  const corrupted = lines.map((line) =>
    line.includes(lose) ? JSON.stringify({ k: lose, v: Buffer.alloc(8).toString('base64') }) : line,
  )
  await writeFile(file, `${[...corrupted, '{not json'].join('\n')}\n`)

  const inner = fakeInner()
  const gateway = open(inner, file)
  assert.equal(gateway.stats().loaded, 1)
  assert.equal(gateway.stats().dropped_on_load, 2)
  await gateway.embed(['keep', 'lose'], 'memory.embed')
  assert.deepEqual(
    inner.calls.map((c) => c.texts),
    [['lose']],
  )

  const other = createCachingGateway(fakeInner(), { file, model: 'other-model', dimensions: DIMS })
  assert.equal(other.stats().loaded, 0, 'another model never reads these vectors')
})

test('the cache file holds hashes and vectors, never text', async () => {
  const file = fileIn('content.jsonl')
  const gateway = open(fakeInner(), file)
  await gateway.prefill([`note ${SENTINEL}`])
  gateway.save()
  const body = await readFile(file, 'utf8')
  assert.equal(body.includes(SENTINEL), false)
  assert.match(body.split('\n')[0], /"model":"text-embedding-3-large","dimensions":4/)
})

test('complete and decide pass through to the wrapped gateway', async () => {
  const gateway = open(fakeInner(), fileIn('pass.jsonl'))
  assert.deepEqual(await gateway.complete('hi', 'op'), { text: 'c:hi' })
  assert.equal((await gateway.decide({}, 'op')).model, 'd')
})
