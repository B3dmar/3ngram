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
import type {
  beginAgentSessionTriage,
  completeAgentSessionTriage,
  openAgentSession,
} from '../src/session/index.js'

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

// The triage facade's layering contract (issue #166 step 7a). Two properties,
// and they pull in opposite directions, which is why both are pinned:
//
//   1. The BODY is `unknown`. These facades are THE validation boundary and
//      parse once, so they must accept what a transport actually holds — a raw
//      body — exactly like `remember`. A parsed input type here would force the
//      route to pre-parse, which is the second boundary hard rule 2 forbids.
//   2. The OPTIONS are fully typed and `thresholds` is MANDATORY. `@3ngram/core`
//      deliberately does not depend on `@3ngram/config`, so the composition root
//      injects the debounce floors; an optional field would let a transport
//      silently fall through to a core-side copy of the defaults, giving the env
//      schema a second, driftable owner.
type BeginOptions = Parameters<typeof beginAgentSessionTriage>[2]

const _requiresThresholds: BeginOptions = {
  thresholds: { minTurns: 3, minElapsedMs: 600_000, minAttemptAgeMs: 30_000 },
}

// @ts-expect-error thresholds are not optional: the transport must supply them.
const _rejectsMissingThresholds: BeginOptions = {}

/** The body is unvalidated by contract — a raw Express body must type-check. */
const _acceptsARawBody: Parameters<typeof beginAgentSessionTriage>[1] = JSON.parse('{"any":1}')
const _completeAcceptsARawBody: Parameters<typeof completeAgentSessionTriage>[1] =
  JSON.parse('{"any":1}')

describe('triage facade signatures', () => {
  it('requires injected debounce thresholds', () => {
    expect(_requiresThresholds.thresholds.minTurns).toBe(3)
    expect(_rejectsMissingThresholds).toBeDefined()
  })

  it('takes the body raw, so the single parse can live inside', () => {
    // The strict-parsing rules themselves are pinned at the schema, which is
    // where they are now the only copy: packages/schema/test/agent-sessions.test.ts.
    expect(_acceptsARawBody).toEqual({ any: 1 })
    expect(_completeAcceptsARawBody).toEqual({ any: 1 })
  })
})
