// SPDX-License-Identifier: Apache-2.0
// TYPE-LEVEL contract for the session-lifecycle facade. These assertions are
// checked by `pnpm run check:test-types` (tsconfig.test.json); the runtime
// assertions below exist so the file is also a real test and cannot rot into a
// never-executed module.
//
// The property: a facade sits at the VALIDATION boundary, so it must accept what
// a caller writes, not what the parser returns. `agentSessionOpenBodySchema`
// defaults `selector`, so `z.infer` marks it REQUIRED — taking that type would
// force every TypeScript caller to hand-write `{ kind: 'all' }`, the exact
// default the schema exists to apply, and a transport forwarding a raw body
// would not type-check at all.
import type { AgentSessionOpenBodyInput } from '@3ngram/schema'
import { describe, expect, it } from 'vitest'
import type { openAgentSession } from '../src/session/index.js'

type OpenArg = Parameters<typeof openAgentSession>[1]

/** The facade takes the z.INPUT type, so `selector` is optional at the call site. */
const _acceptsOmittedSelector: OpenArg = {
  agent: 'claude-code',
  sessionId: 'conv-abc',
  source: 'startup',
}

/** The optional facets and the briefed rows stay assignable alongside it. */
const _acceptsFullBody: OpenArg = {
  agent: 'claude-code',
  sessionId: 'conv-abc',
  source: 'startup',
  project: '3ngram',
  scope: 'work',
  selector: { kind: 'all' },
  briefedMemories: [
    { id: '01890b6e-0000-7000-8000-0000000000c1', topic: 'ship 5a', status: 'open' },
  ],
}

/** And it is exactly the exported input type, not a structural near-miss. */
const _isTheExportedInputType: AgentSessionOpenBodyInput = _acceptsOmittedSelector

// @ts-expect-error `source` is a closed enum: `compact` is a re-inject, never an open.
const _rejectsCompact: OpenArg = { agent: 'a', sessionId: 'c', source: 'compact' }

const _rejectsServerFields: OpenArg = {
  agent: 'a',
  sessionId: 'c',
  source: 'startup',
  // @ts-expect-error server-owned fields never ride the wire.
  activationEpoch: 2,
}

describe('openAgentSession input type', () => {
  it('accepts a body with no selector (the schema supplies the default)', () => {
    expect(_acceptsOmittedSelector.source).toBe('startup')
    expect('selector' in _acceptsOmittedSelector).toBe(false)
  })

  it('accepts a fully specified body', () => {
    expect(_acceptsFullBody.selector).toEqual({ kind: 'all' })
    expect(_isTheExportedInputType.agent).toBe('claude-code')
  })

  it('keeps the rejected shapes referenced so the ts-expect-error lines stay live', () => {
    expect(_rejectsCompact).toBeDefined()
    expect(_rejectsServerFields).toBeDefined()
  })
})
