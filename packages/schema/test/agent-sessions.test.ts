// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  agentSessionRowSchema,
  agentSessionSourceSchema,
  agentSessionTriageStatusSchema,
  briefedMemorySchema,
  sessionProvenancePayloadSchema,
} from '../src/index.js'

const RUN = '01890b6e-0000-7000-8000-000000000001'

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
