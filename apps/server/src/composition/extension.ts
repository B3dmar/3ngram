// SPDX-License-Identifier: Apache-2.0
// The composition seam. The single injection point through which a private
// entrypoint attaches hosted-only capabilities to the Apache server. Generalizes
// the per-feature injection already shipped in app.ts: one port, injected at the
// composition root, carrying zero business logic into Apache transports (docs/concepts/architecture.mdx).
//
// The boundary is a REPO boundary: the hosted platform code lives in a separate
// PRIVATE repo (proprietary), not in this tree. With no extension present,
// createApp resolves `options.extension ?? noOpExtension`, so the self-host build
// runs fully unchanged. Only the private repo's entrypoint constructs a real
// Extension and injects it.
import type { AccessGate, ExportEnricher, Limits } from '@3ngram/core'
import type { CapabilityDescriptor } from '@3ngram/schema'
import type { Express } from 'express'

export interface Extension {
  /** Hosted-only surfaces advertised by the capability document when injected. */
  readonly capabilities: readonly CapabilityDescriptor[]
  /**
   * Optional limits resolver. createApp validates and threads its billing-neutral
   * resource fields through REST/MCP writes, welcome provisioning, and OAuth
   * issuance, while tier/window continue into shared budget enforcement. Absent
   * fields are unlimited; the no-op self-host extension resolves `{}`. No plan
   * values or commercial policy live in this public contract.
   */
  resolveLimits?(userId: string): Promise<Limits>
  /**
   * Hosted-only access gate. When present, createApp threads it into BOTH metered
   * transports so hosted requests are gated by a real access policy. Absent
   * (self-host) the Apache `allowAllAccess` stands, so the self-host artifact gates
   * nothing on access (budget caps still apply). The private repo is the ONLY place
   * a real gate is constructed (no Apache package imports it).
   */
  access?: AccessGate
  /**
   * Hosted-only account-deletion hook. When present, createApp threads it into
   * account deletion so erasing a hosted account can run platform-specific cleanup
   * (e.g. external cancellation). Absent (self-host) deletion completes with no
   * extra work. The private repo is the ONLY place a real hook is constructed (no
   * Apache import).
   */
  onAccountDeletion?(userId: string): Promise<void>
  /**
   * Hosted-only GDPR-export enricher. When present, createApp threads it into the
   * export route so the archive includes extra platform-owned user rows. Absent
   * (self-host) the export omits them. The private repo is the ONLY place a real
   * enricher is constructed (no Apache import).
   */
  exportEnricher?: ExportEnricher
  /** Attach hosted-only routes/handlers to the server at the composition root. */
  register(app: Express): void
}

/** Apache default: advertises nothing and attaches nothing (self-host). */
export const noOpExtension: Extension = {
  capabilities: [],
  register() {},
}

/**
 * Base Apache capabilities — surfaces every deployment offers (self-host and
 * cloud alike), advertised in the capability document alongside any injected
 * hosted-only capabilities. Kept deliberately small: the open-core memory
 * surface is the one always-on capability the boundary scaffolding needs to
 * prove `base ∪ extension`. NO user/tenant content.
 */
export const baseCapabilities: readonly CapabilityDescriptor[] = [
  { name: 'memory.core', available: true, kind: 'rest' },
]
