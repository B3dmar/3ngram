// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  agentSessionRowSchema,
  agentSessionSourceSchema,
  agentSessionTriageStatusSchema,
  briefedMemorySchema,
  DEFAULT_SESSION_EVENTS_LIMIT,
  MAX_SESSION_EVENTS_LIMIT,
  sessionEventsQuerySchema,
  sessionEventsResponseSchema,
  sessionProvenancePayloadSchema,
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
