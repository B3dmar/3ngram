// SPDX-License-Identifier: Apache-2.0
// Capability descriptor (platform foundation). The single
// validation boundary for the advertised capability set a
// deployment offers. Defined once here; produced by an Extension
// (apps/server) and served by the capability surface
// (GET /.well-known/3ngram-capabilities). Carries ONLY surface metadata — NO
// user/tenant content, so the document is safe to serve
// unauthenticated and to log.
import { z } from 'zod'

/** Which client surface a capability affects, so clients hide the right control. */
export const capabilityKindSchema = z.enum(['rest', 'mcp', 'web'])
export type CapabilityKind = z.infer<typeof capabilityKindSchema>

export const capabilityDescriptorSchema = z.object({
  // Stable, kebab/dotted surface id (e.g. `teams.invite`).
  // NO user/tenant content — just the surface name.
  name: z.string().regex(/^[a-z][a-z0-9.-]*$/),
  // Whether THIS deployment offers the surface (true on cloud; hosted-only
  // surfaces are simply absent from a self-host document).
  available: z.boolean(),
  kind: capabilityKindSchema,
})
export type CapabilityDescriptor = z.infer<typeof capabilityDescriptorSchema>

/** The published capability document shape served by the capability surface. */
export const capabilityDocumentSchema = z.object({
  capabilities: z.array(capabilityDescriptorSchema),
})
export type CapabilityDocument = z.infer<typeof capabilityDocumentSchema>
