// SPDX-License-Identifier: Apache-2.0
// listSessionEvents(): the typed provenance read for one agent-session run
// (docs/concepts/session-continuity.mdx layer 3). A pass-through by design —
// the paging, the per-run ceiling and the payload projection all live in
// packages/db; the only thing core adds is the OWNERSHIP gate.
import {
  assertSessionRunOwned,
  type ListSessionEventsOptions,
  listSessionEvents as listSessionEventsDb,
  type SessionEventsPage,
  withTenant,
} from '@3ngram/db'

export type { ListSessionEventsOptions, SessionEventRow, SessionEventsPage } from '@3ngram/db'

/**
 * List the audit events one run produced, oldest first (uuidv7 `id` order).
 *
 * The ownership check is NOT redundant with RLS. RLS would quietly return an
 * empty page for another tenant's run id, which reads as "that run wrote
 * nothing" — the write path's contract is that a run id this tenant does not own
 * FAILS the request, so the read matches it: {@link assertSessionRunOwned}
 * throws `UnknownSessionRunError` (mapped to 400 invalid_input, the same status
 * the write path returns for the same mistake).
 *
 * Runs inside withTenant(): RLS scopes every row to the caller.
 */
export async function listSessionEvents(
  userId: string,
  sessionRunId: string,
  options: ListSessionEventsOptions,
): Promise<SessionEventsPage> {
  await assertSessionRunOwned(userId, sessionRunId)
  return withTenant(userId, (tx) => listSessionEventsDb(tx, userId, sessionRunId, options))
}
