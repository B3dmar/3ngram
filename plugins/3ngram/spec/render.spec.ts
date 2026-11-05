// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

// The pane's isolation gate (selectionConfirmed) is read after the draw's last
// await. A session.start (a reload, /clear, /resume, /branch) closes the gate
// before any await of its own, so a gate read before a later await could draw
// rows held from before the reset. The engine kit cannot hold that await (the
// mocked clock owns `clock.now`, which takes no matcher), so this reads the
// render hook's source.

const SOURCE = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
const GATE = 'selectionConfirmed ?'

// findRenderHook is the first `on('ui.render', …)` call at or under node.
function findRenderHook(node: ts.Node): ts.CallExpression | undefined {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const [event] = node.arguments
    if (
      node.expression.text === 'on' &&
      event !== undefined &&
      ts.isStringLiteral(event) &&
      event.text === 'ui.render'
    )
      return node
  }
  return ts.forEachChild(node, findRenderHook)
}

// renderHook is the source of the render hook's call alone, found by parsing,
// so a hook registered after it is never read as part of it.
function renderHook(source: string): string {
  const file = ts.createSourceFile('register.tsx', source, ts.ScriptTarget.Latest, true)
  const hook = findRenderHook(file)
  assert.ok(hook, 'register.tsx registers a ui.render hook')
  return source.slice(hook.getStart(file), hook.getEnd())
}

// awaitsAfterGate lists the awaits the render hook makes once it has read
// its gate.
function awaitsAfterGate(source: string): string[] {
  const hook = renderHook(source)
  const gate = hook.indexOf(GATE)
  assert.ok(gate > 0, 'the render hook reads selectionConfirmed')
  assert.ok(/\bawait\b/.test(hook.slice(0, gate)), 'the draw awaits before its gate')
  return hook.slice(gate).match(/\bawait\b/g) ?? []
}

test('the pane reads its gate after the last await of the draw', () => {
  assert.deepEqual(awaitsAfterGate(SOURCE), [], 'no await after the gate')
})

test('the check reads the render hook alone, to its end', () => {
  const gateLine = 'const s = selectionConfirmed ? held : unconfirmed(held)'
  assert.ok(SOURCE.includes(gateLine))
  // An await placed after the gate, inside the render hook, is caught.
  const inside = SOURCE.replace(gateLine, `${gateLine}\n    await $.clock.now()`)
  assert.deepEqual(awaitsAfterGate(inside), ['await'])
  // A hook registered after the render hook may await: it is not the draw.
  const end = SOURCE.lastIndexOf('\n}')
  const later = `${SOURCE.slice(0, end)}
  on('session.end', async ($, e, next) => {
    await $.clock.now()
    return next(e)
  })${SOURCE.slice(end)}`
  assert.deepEqual(awaitsAfterGate(later), [])
})
