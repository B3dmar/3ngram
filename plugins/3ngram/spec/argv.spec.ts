// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Selection } from '../hooks/lib/argv.ts'
import { contextArgv, isAllowedArgv, listArgv, selectionKey, showArgv } from '../hooks/lib/argv.ts'

const sel: Selection = { cwd: '/repo', scope: 'work', includeUnscoped: true, github: true }

test('the builders produce the read-only commands, flags included', () => {
  assert.deepEqual(listArgv(sel), [
    '3ngram-hook',
    'commitments',
    'list',
    '--json',
    '--cwd',
    '/repo',
    '--scope',
    'work',
    '--include-unscoped',
    '--github',
  ])
  assert.deepEqual(contextArgv({ ...sel, scope: '', includeUnscoped: false }), [
    '3ngram-hook',
    'commitments',
    'context',
    '--json',
    '--cwd',
    '/repo',
  ])
  assert.deepEqual(showArgv(sel, 'mem-1', 'f1').slice(0, 6), [
    '3ngram-hook',
    'commitments',
    'show',
    'mem-1',
    '--expect-fingerprint',
    'f1',
  ])
  for (const argv of [listArgv(sel), contextArgv(sel), showArgv(sel, 'mem-1', 'f1')]) {
    assert.equal(isAllowedArgv(argv), true, argv.join(' '))
  }
})

test('anything but a read-only commitments command is refused', () => {
  const refused: string[][] = [
    ['3ngram-hook', 'briefing'],
    ['3ngram-hook', 'stop'],
    ['3ngram-hook', 'close'],
    ['3ngram-hook', 'precheck'],
    ['3ngram-hook', 'commitments', 'resolve', 'mem-1'],
    ['3ngram-hook', 'commitments', 'list', '--method', 'POST'],
    ['3ngram-hook', 'commitments', 'show'],
    ['3ngram-hook', 'commitments', 'show', '--scope', 'x'],
    ['3ngram-hook', 'commitments', 'list', '--cwd'],
    ['gh', 'api', '--method', 'GET', 'repos/a/b/issues/1'],
    ['sh', '-c', '3ngram-hook commitments list'],
    ['/usr/local/bin/3ngram-hook', 'commitments', 'list'],
    [],
  ]
  for (const argv of refused) {
    assert.equal(isAllowedArgv(argv), false, argv.join(' '))
  }
})

test('a value position cannot smuggle a flag the allowlist would refuse', () => {
  // `--cwd --github` reads --github as the cwd VALUE; the binary does the same.
  assert.equal(isAllowedArgv(['3ngram-hook', 'commitments', 'list', '--cwd', '--github']), true)
  assert.equal(isAllowedArgv(['3ngram-hook', 'commitments', 'list', '--cwd', '/r', 'stray']), false)
})

test('the selection key changes with what is read, not with GitHub lookups', () => {
  const base = selectionKey(sel)
  assert.notEqual(selectionKey({ ...sel, cwd: '/other' }), base)
  assert.notEqual(selectionKey({ ...sel, scope: 'personal' }), base)
  assert.notEqual(selectionKey({ ...sel, includeUnscoped: false }), base)
  assert.equal(selectionKey({ ...sel, github: false }), base)
})
