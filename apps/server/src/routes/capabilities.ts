// SPDX-License-Identifier: Apache-2.0
// Capability-discovery surface. A thin transport:
// serve the precomputed capability set as a public well-known JSON document so a
// web client can determine which hosted-only surfaces a deployment offers and
// hide unavailable ones cleanly. NOT an MCP tool — the MCP surface is capped at
// ≤12; hosted-only MCP tools hide via non-registration, not a
// client-side step.
//
// The merged set (base Apache ∪ injected extension capabilities) is resolved
// ONCE at boot in app.ts and threaded in here, so the handler stays pure.
import type { CapabilityDescriptor } from '@3ngram/schema'
import { type Request, type Response, Router } from 'express'

/** Well-known path for the capability document (RFC 8615 well-known registry style). */
export const CAPABILITIES_PATH = '/.well-known/3ngram-capabilities'

/**
 * Build the capability-document router over a precomputed capability set. The
 * caller (app.ts) passes `base ∪ extension.capabilities`; on self-host the
 * extension is the no-op default, so only base capabilities are advertised.
 */
export function capabilitiesRouter(capabilities: readonly CapabilityDescriptor[]): Router {
  const router = Router()
  const document = { capabilities: [...capabilities] }
  router.get(CAPABILITIES_PATH, (_req: Request, res: Response) => {
    res.status(200).json(document)
  })
  return router
}
