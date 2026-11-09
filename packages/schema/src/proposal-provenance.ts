// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'

/** Recorded producer of an audit event; never inferred from its event kind. */
export const proposalProvenancePayloadSchema = z
  .object({
    proposalKind: z.enum(['edge', 'fact', 'resolution', 'retention']),
    proposalId: z.uuid(),
  })
  .strict()
export type ProposalProvenancePayload = z.infer<typeof proposalProvenancePayloadSchema>
