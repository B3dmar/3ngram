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
  },
  (t) => [
    unique('agent_sessions_tenant_id_uq').on(t.userId, t.id),
    unique('agent_sessions_natural_key').on(t.userId, t.agent, t.sessionId),
    index('agent_sessions_lease_idx').on(t.userId, t.lastSeenAt),
    check('agent_sessions_source_check', enumCheckSql(t.source, agentSessionSourceSchema.options)),
    check(
      'agent_sessions_triage_check',
      enumCheckSql(t.triageStatus, agentSessionTriageStatusSchema.options),
    ),
    tenantPolicy(),
  ],
)
