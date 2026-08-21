// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
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
