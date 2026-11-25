// SPDX-License-Identifier: Apache-2.0
// Offline tests for the pinned LongMemEval-S sample (#449): the seeded
// stratified selection, the sample guard and the committed fixture. No network,
// no dataset: synthetic instances stand in for upstream.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSampleFixture } from '../scripts/gen-longmemeval-sample.mjs'
import { DEFAULT_BYTES, DEFAULT_SHA256 } from '../src/download.mjs'
import { applySample, SAMPLE_ABSTENTION, SAMPLE_QUOTAS, selectSample } from '../src/sample.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(
  readFileSync(join(here, '../fixtures/longmemeval-s-sample-50.json'), 'utf8'),
)
const SAMPLE_SIZE = Object.values(SAMPLE_QUOTAS).reduce((a, b) => a + b, 0)
const CONTENT_SENTINEL = 'SECRET_QUESTION_TEXT_kumquat_17'

/** 20 answerable + 3 abstention questions per quota type, plus one off-quota type. */
function syntheticInstances() {
  const out = []
  for (const type of [...Object.keys(SAMPLE_QUOTAS), 'off-quota-type']) {
    for (let i = 0; i < 23; i++) {
      const suffix = i >= 20 ? '_abs' : ''
      out.push({
        question_id: `${type}-${String(i).padStart(2, '0')}${suffix}`,
        question_type: type,
        question: CONTENT_SENTINEL,
      })
    }
  }
  return out
}

const typeOf = (id) => id.replace(/-\d+(_abs)?$/, '')

test('selectSample fills every quota with exactly the abstention count', () => {
  const ids = selectSample(syntheticInstances(), { seed: 449 })
  assert.equal(ids.length, SAMPLE_SIZE)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.filter((id) => id.endsWith('_abs')).length, SAMPLE_ABSTENTION)
  const counts = {}
  for (const id of ids) counts[typeOf(id)] = (counts[typeOf(id)] ?? 0) + 1
  assert.deepEqual(counts, { ...SAMPLE_QUOTAS })
})

test('selectSample is reproducible from its seed, whatever the input order', () => {
  const instances = syntheticInstances()
  const a = selectSample(instances, { seed: 449 })
  assert.deepEqual(selectSample([...instances].reverse(), { seed: 449 }), a)
  assert.notDeepEqual(selectSample(instances, { seed: 450 }), a)
})

test('selectSample throws instead of returning a short sample', () => {
  const instances = syntheticInstances()
  const shortType = instances.filter(
    (q) => !(q.question_type === 'knowledge-update' && !q.question_id.endsWith('_abs')),
  )
  assert.throws(() => selectSample(shortType, { seed: 449 }), /knowledge-update: need/)
  const noAbstention = instances.filter((q) => !q.question_id.endsWith('_abs'))
  assert.throws(() => selectSample(noAbstention, { seed: 449 }), /abstention/)
})

test('applySample keeps the sample order and refuses any mismatch', () => {
  const questions = [{ question_id: 'a' }, { question_id: 'b' }, { question_id: 'c' }]
  const sample = { dataset: { sha256: 'abc' }, question_ids: ['c', 'a'] }
  assert.deepEqual(
    applySample(questions, sample, 'abc').map((q) => q.question_id),
    ['c', 'a'],
  )
  assert.throws(() => applySample(questions, sample, 'other'), /drawn from dataset sha256 abc/)
  assert.throws(() => applySample(questions, { question_ids: ['a'] }, 'abc'), /\(none\)/)
  assert.throws(
    () => applySample(questions, { ...sample, question_ids: ['a', 'zz'] }, 'abc'),
    /1 sample id\(s\) not in the dataset/,
  )
  assert.throws(
    () => applySample(questions, { ...sample, question_ids: ['a', 'a'] }, 'abc'),
    /twice/,
  )
})

test('the committed sample is pinned to the download release and holds ids only', () => {
  assert.deepEqual(fixture.dataset, {
    name: 'longmemeval_s',
    sha256: DEFAULT_SHA256,
    bytes: DEFAULT_BYTES,
  })
  assert.deepEqual(fixture.quotas, { ...SAMPLE_QUOTAS })
  assert.equal(fixture.abstention, SAMPLE_ABSTENTION)
  assert.equal(fixture.question_ids.length, SAMPLE_SIZE)
  assert.equal(new Set(fixture.question_ids).size, SAMPLE_SIZE)
  assert.equal(fixture.question_ids.filter((id) => id.endsWith('_abs')).length, SAMPLE_ABSTENTION)
  // Ids only: short id-shaped strings, and no field beyond provenance and ids.
  for (const id of fixture.question_ids) assert.match(id, /^[A-Za-z0-9_]{1,32}$/)
  assert.deepEqual(Object.keys(fixture).sort(), [
    'abstention',
    'dataset',
    'description',
    'question_ids',
    'quotas',
    'seed',
  ])
})

test('buildSampleFixture never carries question content', () => {
  const body = buildSampleFixture(syntheticInstances(), { sha256: 'abc', bytes: 1, seed: 449 })
  assert.equal(JSON.stringify(body).includes(CONTENT_SENTINEL), false)
  assert.equal(body.question_ids.length, SAMPLE_SIZE)
})
