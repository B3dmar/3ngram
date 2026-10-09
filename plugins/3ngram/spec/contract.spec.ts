// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONTRACT, parseEnvelope } from '../hooks/lib/contract.ts'
import { goldenText } from './fixtures.ts'

test('every golden envelope from the Go side parses', () => {
  for (const name of [
    'list-unscoped.json',
    'list-auth.json',
    'context.json',
    'show-review.json',
    'show-outside.json',
  ]) {
    const parsed = parseEnvelope(goldenText(name))
    assert.equal(parsed.ok, true, name)
  }
})

test('a list golden carries rows, counts and its context', () => {
  const parsed = parseEnvelope(goldenText('list-unscoped.json'))
  assert.ok(parsed.ok)
  const e = parsed.envelope
  assert.equal(e.contract, CONTRACT)
  assert.equal(e.commitments?.length, 4)
  assert.equal(e.context.requested.includeUnscoped, true)
  assert.deepEqual(
    e.commitments?.map((r) => r.filing),
    ['project', 'project', 'unscoped', 'unknown'],
  )
})

test('anything that is not one v1 envelope with a fingerprint is refused', () => {
  const ok = JSON.parse(goldenText('list-unscoped.json'))
  const cases: [string, string, string][] = [
    ['not json', 'unknown command: commitments', 'unparseable'],
    ['empty', '', 'unparseable'],
    [
      'other contract',
      JSON.stringify({ ...ok, contract: '3ngram-hook.commitments.v2' }),
      'contract',
    ],
    [
      'no fingerprint',
      JSON.stringify({ ...ok, context: { ...ok.context, fingerprint: '' } }),
      'contract',
    ],
    ['no context', JSON.stringify({ ...ok, context: undefined }), 'contract'],
    ['ok list without rows', JSON.stringify({ ...ok, commitments: undefined }), 'contract'],
    ['array', '[]', 'contract'],
  ]
  for (const [name, text, reason] of cases) {
    const parsed = parseEnvelope(text)
    assert.equal(parsed.ok, false, name)
    if (!parsed.ok) assert.equal(parsed.reason, reason, name)
  }
})
