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
import type { beginAgentSessionTriage, openAgentSession } from '../src/session/index.js'

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

// The triage facade's layering contract (issue #166 step 7a). `@3ngram/core`
// deliberately does not depend on `@3ngram/config`, so the debounce thresholds
// are INJECTED by the composition root rather than read here — which only holds
// if the type makes them mandatory. A `thresholds?:` would let a transport
// silently fall through to a core-side copy of the defaults, giving the env
// schema a second, driftable owner.
type BeginOptions = Parameters<typeof beginAgentSessionTriage>[2]
type BeginBody = Parameters<typeof beginAgentSessionTriage>[1]

const _requiresThresholds: BeginOptions = { thresholds: { minTurns: 3, minElapsedMs: 600_000 } }

// @ts-expect-error thresholds are not optional: the transport must supply them.
const _rejectsMissingThresholds: BeginOptions = {}

/** The turn count is a HINT the hook may omit; the other two disjuncts still apply. */
const _acceptsOmittedTurnCount: BeginBody = { agent: 'claude-code', sessionId: 'conv-abc' }

const _rejectsServerOwnedTriageFields: BeginBody = {
  agent: 'claude-code',
  sessionId: 'conv-abc',
  // @ts-expect-error the server mints the attempt token; a client may not name it.
  attemptId: '01890b6e-0000-7000-8000-0000000000bb',
}

describe('beginAgentSessionTriage input types', () => {
  it('requires injected debounce thresholds', () => {
    expect(_requiresThresholds.thresholds.minTurns).toBe(3)
    expect(_rejectsMissingThresholds).toBeDefined()
  })

  it('treats the turn-count hint as optional and rejects server-owned fields', () => {
    expect('turnCount' in _acceptsOmittedTurnCount).toBe(false)
    expect(_rejectsServerOwnedTriageFields).toBeDefined()
  })
})
