// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'
import { agentNameSchema } from './agent-sessions.js'
import { isoDateTime } from './iso-datetime.js'
import {
  actorKindSchema,
  edgeTypeSchema,
  eventKindSchema,
  memoryStatusSchema,
  memoryTypeSchema,
} from './memory.js'
import { OPEN_OUTPUT_META } from './output-openness.js'
import { proposalProvenancePayloadSchema } from './proposal-provenance.js'
import { retentionActionSchema } from './retention.js'
import { scopeSchema } from './scope.js'
import { MAX_TOPIC_LENGTH, projectSchema, reviseEdgeIntentSchema } from './write.js'

export const MAX_PROVENANCE_IDS = 5
export const MAX_PROVENANCE_EVENTS = 50
export const MAX_PROVENANCE_PROPOSALS = 25
export const MAX_PROVENANCE_FACTS = 25
export const MAX_PROVENANCE_NODES = 25
export const MAX_PROVENANCE_EDGES = 50
export const MAX_PROVENANCE_PRODUCTS = 50

const sourceProposal = proposalProvenancePayloadSchema.nullable()
const origin = z
  .object({
    actorKind: actorKindSchema,
    createdAt: isoDateTime(),
    sessionRunId: z.uuid().nullable(),
    run: z
      .object({
        agent: agentNameSchema.describe(
          'Reported by the session opener; not verified attribution.',
        ),
        openedAt: isoDateTime(),
      })
      .strict()
      .nullable(),
  })
  .strict()

const relative = z
  .object({
    id: z.uuid(),
    memoryType: memoryTypeSchema,
    topic: z.string().max(MAX_TOPIC_LENGTH),
    scope: scopeSchema,
    project: projectSchema.nullable(),
    status: memoryStatusSchema,
    validFrom: isoDateTime(),
    validTo: isoDateTime().nullable(),
    recordedAt: isoDateTime(),
    createdAt: isoDateTime(),
    edgeId: z.uuid(),
    fromId: z.uuid(),
    toId: z.uuid(),
    edgeType: reviseEdgeIntentSchema,
    createdBy: actorKindSchema,
    depth: z
      .number()
      .int()
      .min(1)
      .max(MAX_PROVENANCE_NODES - 1),
    sourceProposal,
    createdBySessionRunId: z.uuid().nullable(),
  })
  .strict()

const event = z
  .object({
    id: z.uuid(),
    eventKind: eventKindSchema,
    actorKind: actorKindSchema,
    createdAt: isoDateTime(),
    sessionRunId: z.uuid().nullable(),
    sourceProposal,
  })
  .strict()

const proposal = z
  .object({
    id: z.uuid(),
    kind: proposalProvenancePayloadSchema.shape.proposalKind,
    edgeType: edgeTypeSchema.nullable(),
    action: retentionActionSchema.nullable(),
    otherMemoryId: z.uuid().nullable(),
    createdAt: isoDateTime(),
    decidedAt: isoDateTime().nullable(),
    produced: z
      .object({
        edgeIds: z.array(z.uuid()).max(MAX_PROVENANCE_PRODUCTS),
        factIds: z.array(z.uuid()).max(MAX_PROVENANCE_PRODUCTS),
        eventIds: z.array(z.uuid()).max(MAX_PROVENANCE_PRODUCTS),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict()

export const memoryProvenanceSchema = z
  .object({
    origin: origin.nullable(),
    supersession: z
      .object({
        predecessors: z.array(relative).max(MAX_PROVENANCE_EDGES),
        successors: z.array(relative).max(MAX_PROVENANCE_EDGES),
        truncated: z.boolean(),
      })
      .strict()
      .refine(
        (section) =>
          section.predecessors.length + section.successors.length <= MAX_PROVENANCE_EDGES,
        { message: 'The combined lineage edge count exceeds its bound' },
      ),
    events: z
      .object({ items: z.array(event).max(MAX_PROVENANCE_EVENTS), truncated: z.boolean() })
      .strict(),
    proposals: z
      .object({ items: z.array(proposal).max(MAX_PROVENANCE_PROPOSALS), truncated: z.boolean() })
      .strict(),
    facts: z
      .object({
        items: z
          .array(
            z
              .object({
                id: z.uuid(),
                validFrom: isoDateTime(),
                validTo: isoDateTime().nullable(),
                sourceProposalId: z.uuid().nullable(),
              })
              .strict(),
          )
          .max(MAX_PROVENANCE_FACTS),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type MemoryProvenance = z.infer<typeof memoryProvenanceSchema>
