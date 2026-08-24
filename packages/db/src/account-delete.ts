// SPDX-License-Identifier: Apache-2.0
// Account-deletion PII erasure (GDPR Art. 17). SQL ONLY
// (hard rule 5): the core wrapper (delete-account.ts) owns the withTenant
// boundary, the cancellation port, and the idempotency policy; the REST transport
// stays thin.
//
// APPEND-ONLY RECONCILIATION (docs/concepts/memory-model.mdx + Hard Rule 1): this NEVER physically
// DELETEs a memory-domain row — it cannot, by grant: the runtime role has
// SELECT/INSERT/UPDATE but NO DELETE on memories/facts/commitments/edges/proposals
// (packages/db/provision-roles.sql). Erasure is a redact-in-place UPDATE that
// clears the PII columns while the structural skeleton (ids, edges, validity
// windows, status) survives — exactly the "PII tombstone" mechanism. The
// redacted email doubles as the durable deletion marker for idempotency.
//
// GRANT-DERIVED SCOPE NOTE: `memory_events` is INSERT/SELECT-only for the runtime
// role (append-only audit trail), so `memory_events.payload` CANNOT be redacted on
// this path. Its erasure mechanism is still undecided (a
// SECURITY DEFINER resolver or an admin path); it is intentionally out of scope of
// this runtime-role function and is recorded as a known gap.
//
// Observability (hard rule 6): logs NOTHING; callers log the id hash + counts only.
import { eq, isNull } from 'drizzle-orm'
import { lockAccountLifecycle, lockPasswordReset, type TenantTx } from './client.js'
import { agentSessions } from './schema/agent-sessions.js'
import {
  apiKeys,
  emailVerificationTokens,
  oauthCodes,
  oauthTokens,
  passwordResetTokens,
  userProfileAttributes,
  userRetrievalPolicy,
  userSessions,
  users,
} from './schema/identity.js'
import {
  commitments,
  consolidationProposals,
  factProposals,
  facts,
  memories,
} from './schema/memory.js'

/** Redaction sentinel written into erased text PII columns. */
export const ERASED_PII = '[erased]'

/** The deterministic post-deletion email — also the idempotency marker. */
export function deletedEmail(userId: string): string {
  return `deleted-${userId}@deleted.invalid`
}

/** An unusable password-hash sentinel (no plaintext can verify against it). */
export const ERASED_PASSWORD_HASH = '!erased'

/**
 * True when a user row is a deletion tombstone: its email has been rewritten to
 * the deterministic deletion marker, or its password hash is the erased sentinel.
 * The credential-issuance paths consult this UNDER the account-lifecycle advisory
 * lock to refuse minting a live credential on a deleted account (resurrection
 * race).
 */
export function isAccountTombstoned(
  userId: string,
  user: { email: string; passwordHash: string },
): boolean {
  return user.email === deletedEmail(userId) || user.passwordHash === ERASED_PASSWORD_HASH
}

/** Per-table row counts touched by an erasure, for an audit tombstone (no PII). */
export interface AccountErasureResult {
  /** True when the account was already erased (idempotent re-run). */
  alreadyErased: boolean
  memories: number
  facts: number
  commitments: number
  proposals: number
  /** Staged fact proposals awaiting review — user content, erased like `facts`. */
  factProposals: number
  /** Session-control rows — excerpt/topics/selector redacted in place (no DELETE). */
  agentSessions: number
  sessionsDeleted: number
  apiKeysRevoked: number
  oauthTokensRevoked: number
  oauthCodesDeleted: number
  passwordResetTokensDeleted: number
  emailVerificationTokensDeleted: number
}

/**
 * Erase the caller's PII in place and revoke their credentials, inside the
 * provided withTenant transaction (RLS scopes the memory-domain UPDATEs to the
 * tenant; the `users` row is keyed by id). Idempotent: a second run detects the
 * deletion-marker email and returns `alreadyErased: true` without re-touching
 * rows. Returns `undefined` when the user row does not exist (the core wrapper
 * decides whether that is an invariant break or an idempotent success).
 *
 * NEVER deletes a memory-domain row (append-only; the grant forbids it). Does NOT
 * erase `memory_events.payload` (INSERT/SELECT-only for the runtime role) — see
 * the file header.
 */
export async function eraseAccountData(
  tx: TenantTx,
  userId: string,
  now: Date,
): Promise<AccountErasureResult | undefined> {
  // Serialize against EVERY concurrent credential path so none can mint a live
  // credential (or set a real password) on this account after we revoke +
  // tombstone it (resurrection race). Two per-user advisory locks,
  // taken in a fixed order (lifecycle then password-reset) to avoid deadlock:
  //  - account-lifecycle: OAuth token issuance/rotation, API-key issuance,
  //    session creation, oauth-code / reset-token / verification-token minting —
  //    each takes this lock and, once it wins, refuses to write on a tombstoned
  //    user (so it either commits-then-gets-revoked-here, or runs after us and is
  //    rejected by the marker check).
  //  - auth_reset_password: the forgotten-password resolver + change-password
  //    path, which UPDATE users.password_hash by id — taking their lock here makes
  //    a password write either commit-then-get-erased-here, or run after us with
  //    its token already burned and the row tombstoned.
  await lockAccountLifecycle(tx, userId)
  await lockPasswordReset(tx, userId)
  const [user] = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (user === undefined) return undefined
  if (user.email === deletedEmail(userId)) {
    return {
      alreadyErased: true,
      memories: 0,
      facts: 0,
      commitments: 0,
      proposals: 0,
      factProposals: 0,
      agentSessions: 0,
      sessionsDeleted: 0,
      apiKeysRevoked: 0,
      oauthTokensRevoked: 0,
      oauthCodesDeleted: 0,
      passwordResetTokensDeleted: 0,
      emailVerificationTokensDeleted: 0,
    }
  }

  // Redact PII in place (RLS scopes each UPDATE to the tenant). content_hash is
  // left intact — it is a structural fingerprint, not PII, and the partial-unique
  // live index keys on it, so leaving it avoids any constraint churn.
  const erasedMemories = await tx
    .update(memories)
    .set({ content: ERASED_PII, topic: ERASED_PII, tags: [], updatedAt: now })
    .returning({ id: memories.id })
  const erasedFacts = await tx
    .update(facts)
    .set({ subject: ERASED_PII, predicate: ERASED_PII, value: ERASED_PII })
    .returning({ id: facts.id })
  const erasedCommitments = await tx
    .update(commitments)
    .set({ owner: null, updatedAt: now })
    .returning({ id: commitments.id })
  const erasedProposals = await tx
    .update(consolidationProposals)
    .set({ rationale: null })
    .returning({ id: consolidationProposals.id })
  // Staged fact proposals carry the SAME user content as `facts` (subject,
  // predicate, value) plus a generated rationale, and they outlive the account:
  // the users row is tombstoned rather than deleted, so the FK's ON DELETE
  // CASCADE never fires and an un-reviewed proposal would survive the erasure
  // with its content intact. Redacted in place (no DELETE grant), matching the
  // facts + consolidation_proposals treatment above. The structural skeleton
  // (ids, memory_id, status, decided_at, validity window) survives.
  const erasedFactProposals = await tx
    .update(factProposals)
    .set({ subject: ERASED_PII, predicate: ERASED_PII, value: ERASED_PII, rationale: null })
    .returning({ id: factProposals.id })
  // agent_sessions is user-owned content (excerpt, briefing topics, selector)
  // and the users row is tombstoned rather than deleted, so the FK cascade
  // never fires. No DELETE grant — redact in place, keep the structural
  // skeleton (id, natural key, lease, triage).
  // INVARIANT: this is the ONLY writer of agent_sessions.project, and it only
  // moves it old→NULL, once. The re-lock loop in session-provenance.ts
  // (attachKnownRun) keys its advisory lock on project and depends on that
  // one-way, one-time mutation for lock-order convergence — any new writer of
  // project must revisit that locking first.
  //
  // INVARIANT: erasure is the FINAL content write for this account. The one
  // other writer of last_message_excerpt is the session heartbeat
  // (session-lifecycle.ts), which is why it takes lockAccountLifecycleShared and
  // re-checks the deletion tombstone before writing that column — this tx holds
  // the same key EXCLUSIVELY (line ~119), so no in-flight heartbeat can write an
  // excerpt back after this redaction commits. Any new writer of user content on
  // this table must take that shared lock and re-check too, or the redaction
  // below stops being final.
  const erasedAgentSessions = await tx
    .update(agentSessions)
    .set({
      project: null,
      scope: null,
      selector: { kind: 'all' as const },
      lastTriagedEventIds: [],
      briefedMemories: [],
      lastMessageExcerpt: ERASED_PII,
      // Reset alongside the state it is derived from. `needs_look` means "this
      // run may hold an event outside last_triaged_event_ids" (session-closer.ts),
      // and the line above discards that watermark — leaving the flag set would
      // point it at a set that no longer exists, and would keep a tombstoned
      // account's whole session history in the closer's candidate index forever.
      // Not user content, so the finality argument above does not apply to it;
      // its only other writers are the attach heartbeat, already tombstone-gated,
      // and the triage stampers, which cannot run on a tombstoned account.
      needsLook: false,
    })
    .returning({ id: agentSessions.id })

  // Revoke credentials. Sessions are deletable (not append-only memory); api keys
  // and oauth tokens are revoked in place (revoked_at) — only the still-live ones.
  // Pending authorization codes are DELETED, not just revoked: an unexchanged code
  // issued just before deletion would otherwise still mint fresh tokens AFTER the
  // account reports every credential revoked. oauth_codes is single-use and
  // DELETE-granted to the runtime role, so deleting it closes that window.
  //
  // Pending password-reset + email-verification tokens are DELETED for the same
  // reason, but the reset token is a HARDER bypass: the reset resolver
  // (migration 0020) sets users.password_hash by user id WITHOUT checking the
  // deletion marker, so a stale reset link minted before deletion could overwrite
  // the `!erased` hash afterward and re-enable login to the tombstoned account
  // (the marker email + user id are deterministic). Burning the tokens here, in
  // the same erasure tx, removes the only input that resolver consumes.
  // Onboarding profiling is user-owned data; erase it IN PLACE (the runtime role
  // is UPDATE-only on this table — no DELETE grant, matching the memory domain).
  // Account deletion tombstones the users row, so the FK ON DELETE CASCADE never
  // fires; this UPDATE is the only thing that clears the survey answers. RLS
  // scopes the write to the caller's row (no explicit WHERE, like the memory
  // erasures above); a never-answered user has no row, so it is a no-op.
  await tx
    .update(userProfileAttributes)
    .set({ role: null, useCase: null, aiTools: null, referralSource: null, updatedAt: now })
  // The users row is tombstoned rather than deleted, so its FK cascade never
  // clears the stored retrieval policy. Remove the user-supplied scope and
  // restore the inert default in this same transaction.
  await tx
    .update(userRetrievalPolicy)
    .set({ mode: 'off', defaultScope: null, updatedAt: now })
    .where(eq(userRetrievalPolicy.userId, userId))
  const deletedSessions = await tx.delete(userSessions).returning({ id: userSessions.id })
  const revokedKeys = await tx
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(isNull(apiKeys.revokedAt))
    .returning({ id: apiKeys.id })
  const revokedTokens = await tx
    .update(oauthTokens)
    .set({ revokedAt: now })
    .where(isNull(oauthTokens.revokedAt))
    .returning({ id: oauthTokens.id })
  const deletedCodes = await tx.delete(oauthCodes).returning({ id: oauthCodes.id })
  const deletedResetTokens = await tx
    .delete(passwordResetTokens)
    .returning({ id: passwordResetTokens.id })
  const deletedVerificationTokens = await tx
    .delete(emailVerificationTokens)
    .returning({ id: emailVerificationTokens.id })

  // Erase account identity last, flipping the email to the deletion marker so the
  // run is idempotent and the password can never again authenticate.
  await tx
    .update(users)
    .set({
      email: deletedEmail(userId),
      passwordHash: ERASED_PASSWORD_HASH,
      emailVerifiedAt: null,
      updatedAt: now,
    })
    .where(eq(users.id, userId))

  return {
    alreadyErased: false,
    memories: erasedMemories.length,
    facts: erasedFacts.length,
    commitments: erasedCommitments.length,
    proposals: erasedProposals.length,
    factProposals: erasedFactProposals.length,
    agentSessions: erasedAgentSessions.length,
    sessionsDeleted: deletedSessions.length,
    apiKeysRevoked: revokedKeys.length,
    oauthTokensRevoked: revokedTokens.length,
    oauthCodesDeleted: deletedCodes.length,
    passwordResetTokensDeleted: deletedResetTokens.length,
    emailVerificationTokensDeleted: deletedVerificationTokens.length,
  }
}
