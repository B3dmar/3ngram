// SPDX-License-Identifier: Apache-2.0
// Access gate port + allow-all default.
//
// The SINGLE read/write access enforcement seam. Apache core depends ONLY on this
// port; a real, platform-specific implementation is injected from the private
// composition root (not present in the self-host build). The Apache default is
// {@link allowAllAccess}, which allows everything — so the self-host artifact
// composes with no extra gating. Budget enforcement is SEPARATE and also Apache
// (see ./budget.ts): self-host gets cost caps under allowAllAccess, gated only by
// the budget, never by an access policy.

/**
 * Read/write access gate. `assertWrite` guards mutating operations; `assertRead`
 * guards reads (search included). A platform implementation throws
 * {@link AccessDeniedError} to deny; the Apache {@link allowAllAccess} never
 * throws. Budget enforcement is independent (./budget.ts).
 */
export interface AccessGate {
  /** Throws {@link AccessDeniedError} when reads are forbidden for `userId`. */
  assertRead(userId: string): Promise<void>
  /** Throws {@link AccessDeniedError} when writes are forbidden for `userId`. */
  assertWrite(userId: string): Promise<void>
}

/**
 * Raised by a platform gate when access is forbidden (a 403-style denial). Apache
 * core defines it so the port contract is complete and transports can map it
 * uniformly; {@link allowAllAccess} never throws it. Carries the bounded access
 * kind only — never any policy internals or content (observability hard rule 6).
 */
export class AccessDeniedError extends Error {
  constructor(public readonly access: 'read' | 'write') {
    super(`${access} access is forbidden`)
    this.name = 'AccessDeniedError'
  }
}

/**
 * Apache default gate (self-host): allows every read and write. Zero policy. The
 * budget gate still applies, so self-host keeps cost caps; only access-policy
 * gating is a no-op here.
 */
export const allowAllAccess: AccessGate = {
  async assertRead(): Promise<void> {},
  async assertWrite(): Promise<void> {},
}
