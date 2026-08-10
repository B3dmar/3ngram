// SPDX-License-Identifier: Apache-2.0
// Offline tests for the embeddings generator's RESPONSE VALIDATION — the barrier
// between an HTTP body and a committed fixture the blocking gate trusts.
//
// Why this file exists: the validation shipped with a hole. `Number(null)` is a
// perfectly finite 0, so a response with holes in it would have been written as a
// vector of real zeros — a fixture that scores instead of failing. These pin the
// barrier so it cannot regress open again.
//
// Importing the generator must not generate, fetch, or exit: everything
// imperative sits behind its main() guard.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { orderedItems, toVector } from '../scripts/gen-tool-selection-embeddings.mjs'

const DIMS = 1536
const vector = (fill = 0.5) => Array.from({ length: DIMS }, () => fill)

test('a well-formed embedding is rebuilt as plain finite numbers', () => {
  const out = toVector(vector(0.25), 0)
  assert.equal(out.length, DIMS)
  assert.ok(out.every((v) => typeof v === 'number' && Number.isFinite(v)))
  // Rebuilt, not passed through: the written array is not the response array.
  const source = vector(0.25)
  assert.notEqual(toVector(source, 0), source)
})

test('a JSON null element is rejected, NOT coerced to zero', () => {
  const holed = vector()
  holed[3] = null
  assert.throws(() => toVector(holed, 7), /item 7: element 3 is null, not a finite number/)
})

test('non-numeric elements are rejected even when they would coerce', () => {
  for (const [value, label] of [
    ['0.5', 'string'],
    [true, 'boolean'],
    [{}, 'object'],
    [[], 'object'],
  ]) {
    const bad = vector()
    bad[0] = value
    assert.throws(() => toVector(bad, 0), new RegExp(`element 0 is ${label}`), `${label} must fail`)
  }
})

test('an all-zero vector of the right length is rejected at generation', () => {
  // Every element is finite and the length is exactly DIMS, so the finiteness and
  // shape checks both pass — the norm floor is the only thing standing between a
  // zero vector and a committed fixture whose cosines are all NaN.
  assert.throws(() => toVector(vector(0), 4), /item 4: vector has zero norm/)
})

test('a wrong-length or non-array embedding is rejected', () => {
  assert.throws(() => toVector(Array(1024).fill(0.1), 0), /expected 1536 numbers, got length 1024/)
  assert.throws(() => toVector(undefined, 2), /expected 1536 numbers, got undefined/)
  assert.throws(() => toVector('<html>', 0), /expected 1536 numbers, got string/)
})

test('a batch returning the wrong item count is rejected', () => {
  assert.throws(() => orderedItems([{ index: 0 }], 2), /expected 2 items, got 1/)
  assert.throws(() => orderedItems(undefined, 2), /expected 2 items, got undefined/)
})

test('items are realigned by their declared index, never by arrival order', () => {
  // The load-bearing one: a reversed response must come back in request order, or
  // every vector would be labelled with the wrong utterance and score plausibly.
  const reversed = [
    { index: 2, embedding: 'c' },
    { index: 1, embedding: 'b' },
    { index: 0, embedding: 'a' },
  ]
  assert.deepEqual(
    orderedItems(reversed, 3).map((i) => i.embedding),
    ['a', 'b', 'c'],
  )
})

test('an unindexed batch keeps arrival order; a partially indexed one is malformed', () => {
  const unindexed = [{ embedding: 'a' }, { embedding: 'b' }]
  assert.deepEqual(
    orderedItems(unindexed, 2).map((i) => i.embedding),
    ['a', 'b'],
  )
  assert.throws(
    () => orderedItems([{ index: 0, embedding: 'a' }, { embedding: 'b' }], 2),
    /mixes indexed and unindexed items/,
  )
})

test('duplicate or out-of-range indices are rejected', () => {
  assert.throws(
    () => orderedItems([{ index: 0 }, { index: 0 }], 2),
    /duplicate or out-of-range index 0/,
  )
  assert.throws(
    () => orderedItems([{ index: 0 }, { index: 5 }], 2),
    /duplicate or out-of-range index 5/,
  )
})
