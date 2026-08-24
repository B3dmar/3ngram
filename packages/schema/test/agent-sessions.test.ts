// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  agentSessionCloseBodySchema,
  agentSessionHeartbeatBodySchema,
  agentSessionOpenBodySchema,
  agentSessionRowSchema,
  agentSessionSourceSchema,
  agentSessionTriageBeginBodySchema,
  agentSessionTriageCompleteBodySchema,
  agentSessionTriageStatusSchema,
  archiveMemoryBodySchema,
  briefedMemorySchema,
  DEFAULT_SESSION_EVENTS_LIMIT,
  debriefPromptQuerySchema,
  MAX_BRIEFED_MEMORIES,
  MAX_SESSION_EVENTS_LIMIT,
  MAX_SESSION_EXCERPT_LENGTH,
  nativeRememberInputSchema,
  resolveToolInputSchema,
  sessionEventSchema,
  sessionEventsQuerySchema,
  sessionEventsResponseSchema,
  sessionProvenancePayloadSchema,
  sessionRunIdSchema,
} from '../src/index.js'

const RUN = '01890b6e-0000-7000-8000-000000000001'
const EVENT = '01890b6e-0000-7000-8000-0000000000e1'
const MEMORY = '01890b6e-0000-7000-8000-0000000000c1'

describe('sessionProvenancePayloadSchema', () => {
  it('accepts only sessionRunId', () => {
    expect(sessionProvenancePayloadSchema.parse({ sessionRunId: RUN })).toEqual({
      sessionRunId: RUN,
    })
  })

  it('rejects extra keys and missing sessionRunId', () => {
    expect(
      sessionProvenancePayloadSchema.safeParse({ sessionRunId: RUN, agent: 'codex' }).success,
    ).toBe(false)
    expect(sessionProvenancePayloadSchema.safeParse({}).success).toBe(false)
  })
})

describe('agent session enums', () => {
  it('source is startup or resume', () => {
    expect(agentSessionSourceSchema.options).toEqual(['startup', 'resume'])
  })

  it('triage status includes overflowed as terminal', () => {
    expect(agentSessionTriageStatusSchema.options).toEqual([
      'idle',
      'pending',
      'completed',
      'expired',
      'overflowed',
    ])
  })
})

describe('agentSessionRowSchema', () => {
  const openedAt = new Date('2026-08-21T12:00:00Z')
  const row = {
    id: RUN,
    agent: 'codex',
    sessionId: 'sess-1',
    source: 'startup',
    project: null,
    scope: null,
    selector: { kind: 'all' },
    activationEpoch: 1,
    triageStatus: 'idle',
    triageAttemptId: null,
    lastTriagedEventIds: [],
    briefedMemories: [],
    lastMessageExcerpt: null,
    openedAt,
    closedAt: null,
    lastSeenAt: openedAt,
    briefingDeliveredAt: null,
  }

  it('accepts a row with the timestamp columns', () => {
    expect(agentSessionRowSchema.parse(row)).toEqual(row)
  })

  it('rejects a row missing openedAt / lastSeenAt', () => {
    expect(
      agentSessionRowSchema.safeParse({
        ...row,
        openedAt: undefined,
        lastSeenAt: undefined,
      }).success,
    ).toBe(false)
  })
})

describe('briefedMemorySchema', () => {
  it('requires id, topic, and status', () => {
    expect(briefedMemorySchema.parse({ id: RUN, topic: 'ship v1.4.4', status: 'open' })).toEqual({
      id: RUN,
      topic: 'ship v1.4.4',
      status: 'open',
    })
    expect(briefedMemorySchema.safeParse({ id: RUN }).success).toBe(false)
  })
})

describe('sessionEventsQuerySchema', () => {
  it('defaults limit and omits cursor on the first page', () => {
    expect(sessionEventsQuerySchema.parse({})).toEqual({ limit: DEFAULT_SESSION_EVENTS_LIMIT })
  })

  it('bounds limit to [1, MAX_SESSION_EVENTS_LIMIT]', () => {
    expect(sessionEventsQuerySchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(sessionEventsQuerySchema.safeParse({ limit: 1.5 }).success).toBe(false)
    expect(
      sessionEventsQuerySchema.safeParse({ limit: MAX_SESSION_EVENTS_LIMIT + 1 }).success,
    ).toBe(false)
    expect(sessionEventsQuerySchema.parse({ limit: MAX_SESSION_EVENTS_LIMIT }).limit).toBe(
      MAX_SESSION_EVENTS_LIMIT,
    )
  })

  it('rejects a non-uuid cursor and unknown keys', () => {
    expect(sessionEventsQuerySchema.safeParse({ cursor: 'not-a-uuid' }).success).toBe(false)
    expect(sessionEventsQuerySchema.safeParse({ cursor: RUN, after: RUN }).success).toBe(false)
  })

  it('round-trips a page-2 cursor as the previous page last item id', () => {
    const page = sessionEventsResponseSchema.parse({
      items: [
        {
          id: EVENT,
          memoryId: MEMORY,
          eventKind: 'create',
          actorKind: 'user_mcp',
          sessionRunId: RUN,
          createdAt: '2026-08-21T12:00:00.000Z',
        },
      ],
      nextCursor: EVENT,
      truncated: false,
    })
    expect(page.nextCursor).toBe(page.items.at(-1)?.id)
    expect(sessionEventsQuerySchema.parse({ cursor: page.nextCursor })).toEqual({
      cursor: EVENT,
      limit: DEFAULT_SESSION_EVENTS_LIMIT,
    })
  })
})

describe('sessionEventsResponseSchema', () => {
  const item = {
    id: EVENT,
    memoryId: MEMORY,
    eventKind: 'supersede',
    actorKind: 'user_api',
    sessionRunId: RUN,
    createdAt: '2026-08-21T12:00:00.000Z',
  }

  it('accepts a truncated final page with no cursor', () => {
    expect(sessionEventsResponseSchema.parse({ items: [item], truncated: true })).toEqual({
      items: [item],
      truncated: true,
    })
  })

  it('rejects an unknown event kind, a raw payload, or an over-long page', () => {
    expect(
      sessionEventsResponseSchema.safeParse({
        items: [{ ...item, eventKind: 'session_end' }],
        truncated: false,
      }).success,
    ).toBe(false)
    expect(
      sessionEventsResponseSchema.safeParse({
        items: [{ ...item, payload: { sessionRunId: RUN } }],
        truncated: false,
      }).success,
    ).toBe(false)
    expect(
      sessionEventsResponseSchema.safeParse({
        items: Array.from({ length: MAX_SESSION_EVENTS_LIMIT + 1 }, () => item),
        truncated: false,
      }).success,
    ).toBe(false)
  })

  it('requires truncated — an absent flag is not a silent false', () => {
    expect(sessionEventsResponseSchema.safeParse({ items: [] }).success).toBe(false)
  })
})

describe('sessionRunIdSchema canonicalization', () => {
  const UPPER = '01890B6E-0000-7000-8000-0000000000AA'
  const LOWER = '01890b6e-0000-7000-8000-0000000000aa'

  it('lowercases an uppercase spelling of a valid uuid', () => {
    expect(sessionRunIdSchema.parse(UPPER)).toBe(LOWER)
    expect(sessionRunIdSchema.parse('01890B6e-0000-7000-8000-0000000000aA')).toBe(LOWER)
  })

  it('leaves an already-canonical id untouched', () => {
    expect(sessionRunIdSchema.parse(LOWER)).toBe(LOWER)
  })

  it('still rejects a non-uuid, whatever its casing', () => {
    expect(sessionRunIdSchema.safeParse('NOT-A-UUID').success).toBe(false)
    expect(sessionRunIdSchema.safeParse('ZZ890B6E-0000-7000-8000-0000000000AA').success).toBe(false)
  })

  it('canonicalizes through EVERY contract that accepts a run id', () => {
    // One shared boundary (hard rule 2): the payload written, the DTO read back,
    // and the native write inputs must not disagree about spelling, or an
    // uppercase query would clear the uuid-typed ownership check and then match
    // nothing in the text comparison the reader and its index use.
    expect(sessionProvenancePayloadSchema.parse({ sessionRunId: UPPER })).toEqual({
      sessionRunId: LOWER,
    })
    expect(
      sessionEventSchema.parse({
        id: EVENT,
        memoryId: MEMORY,
        eventKind: 'create',
        actorKind: 'user_mcp',
        sessionRunId: UPPER,
        createdAt: '2026-08-21T12:00:00.000Z',
      }).sessionRunId,
    ).toBe(LOWER)
    expect(
      nativeRememberInputSchema.parse({
        memoryType: 'note',
        topic: 't',
        content: 'c',
        sessionRunId: UPPER,
      }).sessionRunId,
    ).toBe(LOWER)
    expect(
      resolveToolInputSchema.parse({
        memoryId: MEMORY,
        status: 'resolved',
        sessionRunId: UPPER,
      }).sessionRunId,
    ).toBe(LOWER)
    expect(archiveMemoryBodySchema.parse({ sessionRunId: UPPER }).sessionRunId).toBe(LOWER)
  })

  it('stays representable in JSON Schema in BOTH io directions', () => {
    // A `.transform()` would throw "Transforms cannot be represented in JSON
    // Schema" on io:'output', which is how the MCP reference and tools/list
    // surfaces are generated. `.toLowerCase()` is a type-preserving overwrite.
    for (const io of ['input', 'output'] as const) {
      const json = z.toJSONSchema(resolveToolInputSchema, { target: 'draft-2020-12', io }) as {
        properties: { sessionRunId: { type: string; format: string } }
      }
      expect(json.properties.sessionRunId.type).toBe('string')
      expect(json.properties.sessionRunId.format).toBe('uuid')
    }
  })
})

describe('sessionEventsQuerySchema over a raw Express query object', () => {
  // The route hands req.query through UNMODIFIED so .strict() can see a
  // misspelled key; these cases pin the wire shapes that reaches it.
  it('coerces a string limit and applies the default when absent', () => {
    expect(sessionEventsQuerySchema.parse({ limit: '2' })).toEqual({ limit: 2 })
    expect(sessionEventsQuerySchema.parse({})).toEqual({ limit: DEFAULT_SESSION_EVENTS_LIMIT })
  })

  it('rejects a misspelled pagination key instead of silently restarting at page 1', () => {
    expect(sessionEventsQuerySchema.safeParse({ cursro: EVENT }).success).toBe(false)
    expect(sessionEventsQuerySchema.safeParse({ cursor: EVENT, offset: '1' }).success).toBe(false)
  })

  it('rejects a repeated param (Express yields an array) rather than coercing it', () => {
    expect(sessionEventsQuerySchema.safeParse({ limit: ['1', '2'] }).success).toBe(false)
    expect(sessionEventsQuerySchema.safeParse({ cursor: [EVENT, EVENT] }).success).toBe(false)
  })

  it('rejects the empty string and a non-integer rather than coercing to 0/1.5', () => {
    expect(sessionEventsQuerySchema.safeParse({ limit: '' }).success).toBe(false)
    expect(sessionEventsQuerySchema.safeParse({ limit: '1.5' }).success).toBe(false)
    expect(sessionEventsQuerySchema.safeParse({ limit: 'abc' }).success).toBe(false)
  })

  it('parses a null-prototype object (what Express actually hands the route)', () => {
    const query = Object.assign(Object.create(null), { limit: '3' })
    expect(sessionEventsQuerySchema.parse(query)).toEqual({ limit: 3 })
  })
})

// --- hook-facing lifecycle contracts (issue #166 step 5a) ---

const KEY = { agent: 'claude-code', sessionId: 'conv-abc' }

describe('agentSessionOpenBodySchema', () => {
  it('defaults the selector to the axis-free `all` and leaves the facets absent', () => {
    expect(agentSessionOpenBodySchema.parse({ ...KEY, source: 'startup' })).toEqual({
      ...KEY,
      source: 'startup',
      selector: { kind: 'all' },
    })
  })

  it('accepts the surviving briefed rows the hook reports after its local truncate', () => {
    const briefedMemories = [{ id: RUN, topic: 'ship 5a', status: 'open' }]
    const parsed = agentSessionOpenBodySchema.parse({
      ...KEY,
      source: 'startup',
      project: '3ngram',
      scope: 'work',
      briefedMemories,
    })
    expect(parsed.briefedMemories).toEqual(briefedMemories)
  })

  it('distinguishes an empty briefing from no briefing at all', () => {
    // An empty array is a delivery that surfaced nothing — the server still
    // stamps briefing_delivered_at; an absent key is no delivery.
    expect(
      agentSessionOpenBodySchema.parse({ ...KEY, source: 'startup', briefedMemories: [] })
        .briefedMemories,
    ).toEqual([])
    expect(
      agentSessionOpenBodySchema.parse({ ...KEY, source: 'startup' }).briefedMemories,
    ).toBeUndefined()
  })

  it('bounds the briefed list at MAX_BRIEFED_MEMORIES', () => {
    const row = { id: RUN, topic: 't', status: 'open' }
    const atCap = Array.from({ length: MAX_BRIEFED_MEMORIES }, () => row)
    expect(
      agentSessionOpenBodySchema.safeParse({ ...KEY, source: 'startup', briefedMemories: atCap })
        .success,
    ).toBe(true)
    expect(
      agentSessionOpenBodySchema.safeParse({
        ...KEY,
        source: 'startup',
        briefedMemories: [...atCap, row],
      }).success,
    ).toBe(false)
  })

  it('rejects `compact` and `clear` — neither is an open (compact is never stored)', () => {
    expect(agentSessionOpenBodySchema.safeParse({ ...KEY, source: 'compact' }).success).toBe(false)
    expect(agentSessionOpenBodySchema.safeParse({ ...KEY, source: 'clear' }).success).toBe(false)
  })

  it('rejects a non-kebab agent and an empty harness session id', () => {
    expect(
      agentSessionOpenBodySchema.safeParse({ ...KEY, agent: 'Claude Code', source: 'startup' })
        .success,
    ).toBe(false)
    expect(
      agentSessionOpenBodySchema.safeParse({ ...KEY, sessionId: '', source: 'startup' }).success,
    ).toBe(false)
  })

  it('rejects server-owned fields on the wire', () => {
    // The briefing stamp is the POST, not a client clock; the epoch and the run
    // id are the server's to assign.
    for (const extra of [
      { briefingDeliveredAt: '2026-08-23T10:00:00.000Z' },
      { activationEpoch: 2 },
      { sessionRunId: RUN },
      { userId: RUN },
      { lastMessageExcerpt: 'x' },
    ]) {
      expect(
        agentSessionOpenBodySchema.safeParse({ ...KEY, source: 'startup', ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false)
    }
  })
})

describe('agentSessionCloseBodySchema', () => {
  it('is the natural key and nothing else — close never carries an epoch', () => {
    expect(agentSessionCloseBodySchema.parse(KEY)).toEqual(KEY)
    expect(agentSessionCloseBodySchema.safeParse({ ...KEY, activationEpoch: 3 }).success).toBe(
      false,
    )
    expect(agentSessionCloseBodySchema.safeParse({ ...KEY, sessionRunId: RUN }).success).toBe(false)
  })
})

describe('agentSessionHeartbeatBodySchema', () => {
  it('bounds the excerpt at MAX_SESSION_EXCERPT_LENGTH', () => {
    const atCap = 'x'.repeat(MAX_SESSION_EXCERPT_LENGTH)
    expect(
      agentSessionHeartbeatBodySchema.parse({ ...KEY, lastMessageExcerpt: atCap })
        .lastMessageExcerpt,
    ).toHaveLength(MAX_SESSION_EXCERPT_LENGTH)
    expect(
      agentSessionHeartbeatBodySchema.safeParse({ ...KEY, lastMessageExcerpt: `${atCap}x` })
        .success,
    ).toBe(false)
  })

  it('rejects an empty excerpt rather than storing a meaningless snapshot', () => {
    expect(
      agentSessionHeartbeatBodySchema.safeParse({ ...KEY, lastMessageExcerpt: '' }).success,
    ).toBe(false)
  })

  it('takes the natural key with no excerpt at all', () => {
    expect(agentSessionHeartbeatBodySchema.parse(KEY)).toEqual(KEY)
  })
})

describe('debriefPromptQuerySchema', () => {
  it('accepts no arguments at all', () => {
    expect(debriefPromptQuerySchema.parse({})).toEqual({})
  })

  it('requires agent and sessionId to move together', () => {
    expect(debriefPromptQuerySchema.safeParse(KEY).success).toBe(true)
    expect(debriefPromptQuerySchema.safeParse({ agent: 'claude-code' }).success).toBe(false)
    expect(debriefPromptQuerySchema.safeParse({ sessionId: 'conv-abc' }).success).toBe(false)
  })

  it('rejects an unknown key and a repeated param', () => {
    expect(debriefPromptQuerySchema.safeParse({ scopes: 'work' }).success).toBe(false)
    expect(debriefPromptQuerySchema.safeParse({ scope: ['work', 'personal'] }).success).toBe(false)
  })

  it('validates scope against the same constraint the remember TOOL enforces', () => {
    expect(debriefPromptQuerySchema.safeParse({ scope: 'Work Notes' }).success).toBe(false)
    expect(debriefPromptQuerySchema.parse({ scope: 'work' })).toEqual({ scope: 'work' })
  })
})

// The Stop-nudge handshake bodies (issue #166 step 7a). These schemas are THE
// validation boundary for both triage routes: the transports pass the raw body
// and `beginAgentSessionTriage` / `completeAgentSessionTriage` parse once, so
// the strict-parsing contract belongs here — against the real schemas — rather
// than against a transport that no longer pre-parses.
describe('agentSessionTriageBeginBodySchema', () => {
  it('takes the natural key alone — the turn count is an optional hint', () => {
    expect(agentSessionTriageBeginBodySchema.parse(KEY)).toEqual(KEY)
    expect(agentSessionTriageBeginBodySchema.parse({ ...KEY, turnCount: 4 }).turnCount).toBe(4)
  })

  it('bounds the turn count and refuses a non-integer or a string', () => {
    // A sanity bound on a number the hook counts out of harness stdin. It does
    // NOT coerce: this is a JSON body, not a query string, so `'4'` is a client
    // bug worth surfacing rather than a value to guess at.
    for (const turnCount of [-1, 1.5, 100_001, '4', null]) {
      expect(
        agentSessionTriageBeginBodySchema.safeParse({ ...KEY, turnCount }).success,
        String(turnCount),
      ).toBe(false)
    }
    expect(agentSessionTriageBeginBodySchema.safeParse({ ...KEY, turnCount: 0 }).success).toBe(true)
    expect(
      agentSessionTriageBeginBodySchema.safeParse({ ...KEY, turnCount: 100_000 }).success,
    ).toBe(true)
  })

  it('rejects server-owned triage state a client must never name', () => {
    // The server mints the attempt token, owns the status, and owns the
    // watermark. `.strict()` is what makes a client that tries to set one a 400
    // rather than a silently-ignored field.
    for (const extra of [
      { attemptId: RUN },
      { triageStatus: 'idle' },
      { lastTriagedEventIds: [] },
      { armed: true },
      { turncount: 4 },
    ]) {
      expect(
        agentSessionTriageBeginBodySchema.safeParse({ ...KEY, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false)
    }
  })

  it('holds the natural key to the same constraints every other hook route uses', () => {
    expect(agentSessionTriageBeginBodySchema.safeParse({ agent: 'Claude Code' }).success).toBe(
      false,
    )
    expect(agentSessionTriageBeginBodySchema.safeParse({ agent: 'claude-code' }).success).toBe(
      false,
    )
    expect(agentSessionTriageBeginBodySchema.safeParse({ ...KEY, sessionId: '' }).success).toBe(
      false,
    )
  })
})

describe('agentSessionTriageCompleteBodySchema', () => {
  it('requires the attempt id — it is the fence, not an optional hint', () => {
    expect(agentSessionTriageCompleteBodySchema.parse({ ...KEY, attemptId: RUN })).toEqual({
      ...KEY,
      attemptId: RUN,
    })
    expect(agentSessionTriageCompleteBodySchema.safeParse(KEY).success).toBe(false)
  })

  it('rejects a malformed attempt id and unknown keys', () => {
    for (const body of [
      { ...KEY, attemptId: 'not-a-uuid' },
      { ...KEY, attemptId: null },
      { ...KEY, attemptId: RUN, triageStatus: 'completed' },
      { ...KEY, attemptId: RUN, turnCount: 4 },
      { ...KEY, attemptid: RUN },
    ]) {
      expect(
        agentSessionTriageCompleteBodySchema.safeParse(body).success,
        JSON.stringify(body).slice(0, 60),
      ).toBe(false)
    }
  })
})
