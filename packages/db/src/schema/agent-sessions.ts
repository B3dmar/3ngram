// SPDX-License-Identifier: Apache-2.0
// Session-control table (docs/concepts/session-continuity.mdx). User-owned:
// explicit user_id, RLS + FORCE, unique natural key (user_id, agent, session_id),
// user_id-leading indexes. UPDATE is granted (lease, triage, close); DELETE is
// not — close is an update. Not in the retrieval path.
import {
  agentSessionSourceSchema,
  agentSessionTriageStatusSchema,
  type BriefedMemory,
  type BriefingSelectorV2Input,
} from '@3ngram/schema'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { enumCheckSql, tenantPolicy } from './helpers.js'
import { users } from './identity.js'

const uuidv7 = () => sql`uuidv7()`

export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agent: text('agent').notNull(),
    sessionId: text('session_id').notNull(),
    source: text('source').notNull(),
    project: text('project'),
    scope: text('scope'),
    selector: jsonb('selector').notNull().$type<BriefingSelectorV2Input>(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    activationEpoch: integer('activation_epoch').notNull().default(1),
    triageStatus: text('triage_status').notNull().default('idle'),
    triageAttemptId: uuid('triage_attempt_id'),
    lastTriagedEventIds: jsonb('last_triaged_event_ids').notNull().default([]).$type<string[]>(),
    briefingDeliveredAt: timestamp('briefing_delivered_at', { withTimezone: true }),
    briefedMemories: jsonb('briefed_memories').notNull().default([]).$type<BriefedMemory[]>(),
    lastMessageExcerpt: text('last_message_excerpt'),
    // THE CLOSER'S SCAN DISCRIMINATOR (issue #183). "This run may hold a
    // provenance event outside `last_triaged_event_ids`." Not user content and
    // not part of the Stop-handshake vocabulary — `triage_status` stays exactly
    // the five words layer 4 reads. See session-closer.ts `settleNeedsLook`.
    needsLook: boolean('needs_look').notNull().default(false),
  },
  (t) => [
    unique('agent_sessions_tenant_id_uq').on(t.userId, t.id),
    unique('agent_sessions_natural_key').on(t.userId, t.agent, t.sessionId),
    index('agent_sessions_lease_idx').on(t.userId, t.lastSeenAt).where(sql`${t.closedAt} IS NULL`),
    // The closer's candidate scan is the exact OPPOSITE predicate to the lease
    // index (`closed_at IS NOT NULL`, ordered by `closed_at`), so that index
    // cannot serve it: a tenant with a long session history would re-scan and
    // re-sort every row of it on each sweep tick. LIMIT bounds the rows
    // returned, not the work done, and agent_sessions is never routinely
    // deleted. Excluding the terminal status keeps the index to rows a closer
    // could still act on.
    //
    // SETTLED HISTORY LEAVES THE INDEX (issue #183). `completed` is the terminal
    // state of the HAPPY path, so without the `needs_look` leg every session a
    // tenant ever ran stays in the index and — sorted by `closed_at` — sorts
    // FIRST, ahead of the backlog the scan is actually looking for. The cost
    // then grows with history rather than with load. `needs_look` is the one bit
    // that distinguishes a settled `completed` row from one that may still hold
    // an event outside its watermark, and only the latter can ever be a
    // candidate, so only the latter belongs here.
    index('agent_sessions_closer_idx')
      .on(t.userId, t.closedAt)
      .where(
        sql`${t.closedAt} IS NOT NULL AND ${t.triageStatus} <> 'overflowed' AND (${t.triageStatus} <> 'completed' OR ${t.needsLook})`,
      ),
    check('agent_sessions_source_check', enumCheckSql(t.source, agentSessionSourceSchema.options)),
    check(
      'agent_sessions_triage_check',
      enumCheckSql(t.triageStatus, agentSessionTriageStatusSchema.options),
    ),
    tenantPolicy(),
  ],
)
