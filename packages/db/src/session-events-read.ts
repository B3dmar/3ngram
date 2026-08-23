// SPDX-License-Identifier: Apache-2.0
// listSessionEvents(): the typed provenance read for one run
// (docs/concepts/session-continuity.mdx layer 3). Read-only and payload-NARROW:
// it projects exactly one payload key (`sessionRunId`) with a jsonb operator and
// parses it through sessionProvenancePayloadSchema — never `payload` as a blob,
// never an arbitrary payload key. No memory content, topic, tags or hashes.
//
// Runs inside withTenant(); RLS scopes every row to the caller. Ownership of the
// run id itself is asserted by the caller (core uses assertSessionRunOwned), so
// an unowned id FAILS rather than returning an empty page.
//
// INDEX COMPATIBILITY: both statements below must be served by
//   memory_events_session_idx (user_id, (payload->>'sessionRunId'), id)
//     WHERE payload->>'sessionRunId' IS NOT NULL
// so the predicate is spelled with the SAME expression as the index
// (schema/memory.ts) and never wrapped in a cast or a function. The equality is
// on a strict operator, which implies the index's IS NOT NULL predicate, so the
// partial index applies. Ordering and the keyset are on `id` (uuidv7), which is
// the index's trailing column — no sort node, and the ceiling probe is an
// index-only scan bounded at `ceiling + 1` entries.
import { MAX_SESSION_EVENT_IDS, sessionProvenancePayloadSchema } from '@3ngram/schema'
import { and, asc, eq, gt, lt, type SQL, sql } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { memoryEvents } from './schema/memory.js'

/** One audit event stamped with this run's provenance. */
export interface SessionEventRow {
  id: string
  memoryId: string
  eventKind: string
  actorKind: string
  sessionRunId: string
  createdAt: Date
}

/**
 * One page of a run's events. `nextCursor` is the last item's `id` when another
 * page exists WITHIN the ceiling; `truncated` is the separate, terminal signal
 * that the run holds more events than the ceiling admits at all (the closer
 * treats such a run as `overflowed` and does not re-claim it).
 */
export interface SessionEventsPage {
  items: SessionEventRow[]
  nextCursor: string | undefined
  truncated: boolean
}

export interface ListSessionEventsOptions {
  /** Keyset position: the `id` of the last item of the previous page. */
  cursor?: string | undefined
  /** Hard per-call page size. Bounded at the schema boundary. */
  limit: number
  /**
   * Per-run ceiling. Injected ONLY so a test can exercise the truncation branch
   * without inserting MAX_SESSION_EVENT_IDS + 1 rows; production always takes
   * the default.
   */
  ceiling?: number | undefined
}

/**
 * The one payload key this module may touch. Spelling is load-bearing: it must
 * match sessionProvenancePayloadSchema's key AND the expression index.
 */
function sessionRunIdExpr(): SQL<string | null> {
  return sql`${memoryEvents.payload}->>'sessionRunId'`
}

function runPredicate(userId: string, sessionRunId: string): SQL | undefined {
  return and(eq(memoryEvents.userId, userId), eq(sessionRunIdExpr(), sessionRunId))
}

/**
 * The `id` of the first event PAST the ceiling, or undefined when the run fits.
 * Its presence is both the `truncated` flag and the exclusive upper bound that
 * keeps pagination from walking past the ceiling.
 */
async function ceilingBoundary(
  tx: TenantTx,
  userId: string,
  sessionRunId: string,
  ceiling: number,
): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: memoryEvents.id })
    .from(memoryEvents)
    .where(runPredicate(userId, sessionRunId))
    .orderBy(asc(memoryEvents.id))
    .offset(ceiling)
    .limit(1)
  return row?.id
}

/**
 * List the audit events a run produced, oldest first, keyset-paginated on the
 * uuidv7 `id`. Events whose payload lacks the key are not in the index and
 * cannot match the equality, so they never appear.
 */
export async function listSessionEvents(
  tx: TenantTx,
  userId: string,
  sessionRunId: string,
  options: ListSessionEventsOptions,
): Promise<SessionEventsPage> {
  const ceiling = options.ceiling ?? MAX_SESSION_EVENT_IDS
  const boundary = await ceilingBoundary(tx, userId, sessionRunId, ceiling)
  const rows = await tx
    .select({
      id: memoryEvents.id,
      memoryId: memoryEvents.memoryId,
      eventKind: memoryEvents.eventKind,
      actorKind: memoryEvents.actorKind,
      sessionRunId: sessionRunIdExpr(),
      createdAt: memoryEvents.createdAt,
    })
    .from(memoryEvents)
    .where(
      and(
        runPredicate(userId, sessionRunId),
        options.cursor === undefined ? undefined : gt(memoryEvents.id, options.cursor),
        boundary === undefined ? undefined : lt(memoryEvents.id, boundary),
      ),
    )
    .orderBy(asc(memoryEvents.id))
    .limit(options.limit + 1)

  const hasMore = rows.length > options.limit
  const page = hasMore ? rows.slice(0, options.limit) : rows
  const items = page.map((row) => ({
    id: row.id,
    memoryId: row.memoryId,
    eventKind: row.eventKind,
    actorKind: row.actorKind,
    // The projected key goes through the payload contract, not a bare cast: a
    // row that somehow carries a non-uuid there is a corrupt write, not a value
    // to hand to a caller.
    sessionRunId: sessionProvenancePayloadSchema.parse({ sessionRunId: row.sessionRunId })
      .sessionRunId,
    createdAt: row.createdAt,
  }))
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1]?.id : undefined,
    truncated: boundary !== undefined,
  }
}
