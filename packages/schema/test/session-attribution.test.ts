// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  archiveEventPayloadSchema,
  archiveMemoryBodySchema,
  nativeRememberInputSchema,
  nativeReviseDispositionInputSchema,
  nativeReviseInputSchema,
  nativeReviseMoveInputSchema,
  reaffirmEventPayloadSchema,
  rememberWithFactsInputSchema,
  resolveToolInputSchema,
  reviseMoveEventPayloadSchema,
  sessionProvenancePayloadSchema,
} from '../src/index.js'

const ID = '01890b6e-0000-7000-8000-000000000001'
const memory = { memoryType: 'note', topic: 'attribution', content: 'independent write' }

describe('explicit no-attribution input', () => {
  it.each([
    [nativeRememberInputSchema, memory],
    [nativeReviseInputSchema, { ...memory, predecessorId: ID }],
    [nativeReviseMoveInputSchema, { kind: 'move', predecessorId: ID, tags: ['moved'] }],
    [nativeReviseDispositionInputSchema, { kind: 'archive', memoryIds: [ID] }],
    [nativeReviseDispositionInputSchema, { kind: 'reaffirm', memoryIds: [ID] }],
    [resolveToolInputSchema, { memoryId: ID, status: 'resolved' }],
    [archiveMemoryBodySchema, {}],
  ] as const)('preserves null distinctly from omission in each native input', (schema, input) => {
    expect(schema.parse({ ...input, sessionRunId: null }).sessionRunId).toBeNull()
    expect(schema.parse(input).sessionRunId).toBeUndefined()
  })

  it('does not admit null attribution into import or stored event payloads', () => {
    expect(rememberWithFactsInputSchema.safeParse({ ...memory, sessionRunId: null }).success).toBe(
      false,
    )
    expect(sessionProvenancePayloadSchema.safeParse({ sessionRunId: null }).success).toBe(false)
    expect(
      archiveEventPayloadSchema.safeParse({ disposition: 'archive', sessionRunId: null }).success,
    ).toBe(false)
    expect(
      reaffirmEventPayloadSchema.safeParse({ disposition: 'reaffirm', sessionRunId: null }).success,
    ).toBe(false)
    const filing = { scope: 'work', project: null, tagCount: 0 }
    expect(
      reviseMoveEventPayloadSchema.safeParse({
        disposition: 'move',
        from: filing,
        to: filing,
        sessionRunId: null,
      }).success,
    ).toBe(false)
  })
})
