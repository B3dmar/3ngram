// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// The pane's isolation gate (selectionConfirmed) is read after the draw's last
// await. A session.start (a reload, /clear, /resume, /branch) closes the gate
// before any await of its own, so a gate read before a later await could draw
// rows held from before the reset. The engine kit cannot hold that await (the
// mocked clock owns `clock.now`, which takes no matcher), so this reads the
// render hook's source.
test('the pane reads its gate after the last await of the draw', () => {
  const source = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
  const hook = source.slice(source.indexOf("on('ui.render'"))
  const gate = hook.indexOf('selectionConfirmed ?')
  assert.ok(gate > 0, 'the render hook reads selectionConfirmed')
  assert.ok(/\bawait\b/.test(hook.slice(0, gate)), 'the draw awaits before its gate')
  assert.deepEqual(hook.slice(gate).match(/\bawait\b/g), null, 'no await after the gate')
})
