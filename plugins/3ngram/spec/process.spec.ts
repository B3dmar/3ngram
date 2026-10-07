// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyEmptyOutput, classifySpawnError } from '../hooks/lib/process.ts'

test('the engine wording for a binary not on PATH reads as missing_binary', () => {
  // Captured from Claude Code 2.1.292 in the #255 spike.
  const real =
    '3ngram: $.process.spawn(3ngram-hook) failed to start: ENOENT: Executable not found in $PATH: "3ngram-hook"'
  assert.equal(classifySpawnError(real), 'missing_binary')
  assert.equal(classifySpawnError('hooks stream chain failed'), 'crash')
})

test('a binary from before the commitments command is told apart', () => {
  assert.equal(classifyEmptyOutput('unknown command: commitments\n'), 'too_old')
  assert.equal(classifyEmptyOutput('panic: runtime error'), 'crash')
  assert.equal(classifyEmptyOutput(''), 'crash')
})
