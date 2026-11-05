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
// render hook's source (register.tsx) and the drawing it hands the gated
// state to (pane.tsx), which must never suspend either.

const SOURCE = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
const PANE_SOURCE = readFileSync(new URL('../hooks/pane.tsx', import.meta.url), 'utf8')
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

// suspensions lists what in a file could suspend a drawing: an await, a for
// await, a function marked async, or a promise made without either (the name
// Promise, or a `.then`), whose promise the render hook would hand on to
// settle after the gate. Read from the syntax tree, so a comment naming an
// await is not one.
function suspensions(source: string): string[] {
  const file = ts.createSourceFile('pane.tsx', source, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) found.push('await')
    if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) found.push('for await')
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
    if (modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) found.push('async')
    if (ts.isIdentifier(node) && node.text === 'Promise') found.push('Promise')
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'then') found.push('.then')
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

test('the pane reads its gate after the last await of the draw', () => {
  assert.deepEqual(awaitsAfterGate(SOURCE), [], 'no await after the gate')
})

function lastAwait(source: string): string | undefined {
  const hook = renderHook(source)
  const file = ts.createSourceFile('register.tsx', hook, ts.ScriptTarget.Latest, true)
  const awaits: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) awaits.push(node.expression.getText(file))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return awaits.at(-1)
}

test('commitments are read last so no later state read can outlive their context', () => {
  assert.equal(lastAwait(SOURCE), 'readPanel($)')
  const changed = SOURCE.replace(
    'const held = await readPanel($)',
    'const held = await readPanel($)\n    await readActivity($)',
  )
  assert.equal(lastAwait(changed), 'readActivity($)', 'the guard detects an extra state read')
})

test('the drawing behind the gate never suspends', () => {
  assert.ok(renderHook(SOURCE).includes('return drawPane('), 'the render hook draws with pane.tsx')
  assert.deepEqual(suspensions(PANE_SOURCE), [], 'pane.tsx is synchronous')
  for (const path of ['session-pane.tsx', 'lib/session-view.ts']) {
    const source = readFileSync(new URL(`../hooks/${path}`, import.meta.url), 'utf8')
    assert.deepEqual(suspensions(source), [], `${path} is synchronous`)
  }
})

test('the drawing check catches an async draw and an await inside it', () => {
  const head = 'export function drawPane('
  const body = 'const shownDetail = visibleDetail(s)'
  assert.ok(PANE_SOURCE.includes(head) && PANE_SOURCE.includes(body))
  const asyncDraw = PANE_SOURCE.replace(head, 'export async function drawPane(')
  assert.deepEqual(suspensions(asyncDraw), ['async'])
  const awaiting = asyncDraw.replace(body, `${body}\n  await Promise.resolve()`)
  assert.deepEqual(suspensions(awaiting), ['async', 'await', 'Promise'])
})

// #415 review: a drawing can hand back a promise with no async and no await.
test('the drawing check catches a promise returned without async', () => {
  const tail = 'return drawList(ui, panelView(s, clock), columns, act)'
  assert.ok(PANE_SOURCE.includes(tail))
  const draw = 'drawList(ui, panelView(s, clock), columns, act)'
  const chained = PANE_SOURCE.replace(tail, `return Promise.resolve().then(() => ${draw})`)
  assert.deepEqual(suspensions(chained), ['.then', 'Promise'])
  const made = PANE_SOURCE.replace(tail, `return Promise.resolve(${draw})`)
  assert.deepEqual(suspensions(made), ['Promise'])
  // A thenable from elsewhere, with no Promise named in this file.
  const thenable = PANE_SOURCE.replace(tail, `return act.later().then(() => ${draw})`)
  assert.deepEqual(suspensions(thenable), ['.then'])
})

test('the check reads the render hook alone, to its end', () => {
  const gateLine = 'const s = runtime.selectionConfirmed ? held : unconfirmed(held)'
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
