// SPDX-License-Identifier: Apache-2.0
// First-account provisioning. On a
// user's FIRST successful email verification, register the default scopes and
// seed one welcome memory so the account's first recall is never empty.
//
// BEST-EFFORT + IDEMPOTENT: every step swallows its own "already there" conflict
// (a scope-name collision, a duplicate-content memory), so a re-run — the
// deferred dashboard re-seed after a transient failure at verification —
// never double-seeds. Callers MUST treat the whole thing as best-effort and
// swallow any other error: provisioning must never fail or delay the
// verification response (the seed is re-attempted on the next dashboard load).
//
// Observability (hard rule 6): this module logs nothing and never sees a
// password; it writes only the system-authored welcome content below.
import { DEFAULT_SCOPES } from '@3ngram/schema'
import { createScope, ScopeNameConflictError } from '../scope/scopes.js'
import { DuplicateMemoryError, type EmbedOptions, remember } from '../write/remember.js'

/** The welcome memory lands in the first default scope ('personal'). */
const WELCOME_SCOPE = DEFAULT_SCOPES[0]

/**
 * System-authored first memory. Kept under the 2000-char content cap and written
 * as a `note` so it never lands in a commitment/blocker briefing. Editable and
 * deletable by the user like any other memory (append-and-supersede, hard rule 1).
 */
const WELCOME_MEMORY = {
  memoryType: 'note',
  topic: 'Welcome to 3ngram',
  content:
    'Welcome to 3ngram — your memory that persists across AI sessions and tools. ' +
    'Anything you ask an agent to remember lands here and stays searchable from any ' +
    'conversation. Try asking your agent to recall this note, or save a new fact and ' +
    'watch it appear. This note is yours: edit it or delete it whenever you like.',
  scope: WELCOME_SCOPE,
  tags: ['welcome'],
} as const

/**
 * Provision a freshly verified account: register the default scopes and seed the
 * welcome memory under the user's tenant (via the append write path, so RLS and
 * the audit event apply exactly as for any user write). Idempotent — re-running
 * swallows the scope-name conflict and the duplicate-memory guard. Embedding is
 * optional: with no injected gateway the welcome memory is stored with a NULL
 * embedding (still listable / FTS-searchable) and can be backfilled later.
 *
 * Best-effort by contract: this resolves on the expected conflicts but lets an
 * unexpected error propagate so the caller can decide — verifyEmail swallows it
 * and relies on the deferred dashboard re-seed.
 */
export async function provisionVerifiedAccount(
  userId: string,
  embedOptions: EmbedOptions = {},
): Promise<void> {
  for (const scope of DEFAULT_SCOPES) {
    try {
      await createScope(userId, scope, [])
    } catch (error) {
      if (!(error instanceof ScopeNameConflictError)) throw error
    }
  }

  try {
    await remember(userId, WELCOME_MEMORY, 'system', embedOptions)
  } catch (error) {
    if (!(error instanceof DuplicateMemoryError)) throw error
  }
}
