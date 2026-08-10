// SPDX-License-Identifier: Apache-2.0
// Memory domain (docs/concepts/memory-model.mdx, docs/concepts/data-model.mdx). Every table here is user-owned:
// explicit user_id, RLS with the NULLIF guard, composite tenant-qualified FKs
// so cross-tenant references are unrepresentable, user_id-leading indexes.

import {
  actorKindSchema,
  commitmentStatusSchema,
  edgeTypeSchema,
  eventKindSchema,
  memoryStatusSchema,
  memoryTypeSchema,
  proposalStatusSchema,
} from '@3ngram/schema'
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'
import { enumCheckSql, tenantPolicy } from './helpers.js'
import { users } from './identity.js'

const uuidv7 = () => sql`uuidv7()`

export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    memoryType: text('memory_type').notNull(),
    topic: text('topic').notNull(),
    content: text('content').notNull(),
    scope: text('scope').notNull().default('personal'),
    project: text('project'),
    status: text('status').notNull().default('active'),
    // Free-form categorisation tags (2026-06-05 decision). jsonb,
    // not text[] or a join table: repo precedent stores string lists as jsonb
    // (scopes.aliases, oauth_clients.redirect_uris), and append-and-supersede
    // (docs/concepts/memory-model.mdx) makes a normalised join table's mutation wins unreachable —
    // tags are written exactly once, atomically with the memory. The single
    // Zod boundary (rememberInputSchema: <=32 tags x <=64 chars) covers
    // jsonb's DB-side typelessness. Tags stay OUT of the FTS tsvector (0006).
    tags: jsonb('tags').notNull().default([]).$type<string[]>(),
    embedding: vector('embedding', { dimensions: 1536 }),
    contentHash: text('content_hash').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // FTS leg (migration 0006): a GENERATED STORED tsvector over
    // topic + content (english) with a GIN index lives in the DB but is
    // intentionally NOT modeled here. drizzle-kit cannot express a generated
    // tsvector column, and Drizzle has no first-class tsvector type; the
    // column is DB-maintained and read-only, queried via raw SQL in
    // src/search.ts. Keeping it out of the snapshot prevents generator drift.
  },
  (t) => [
    // FK target for composite tenant-qualified references — must be a UNIQUE
    // CONSTRAINT (not index): FKs require it, and it must exist in CREATE TABLE
    unique('memories_tenant_id_uq').on(t.userId, t.id),
    index('memories_type_idx').on(t.userId, t.memoryType),
    index('memories_scope_idx').on(t.userId, t.scope, t.status),
    // Partial UNIQUE backstop for the in-transaction duplicate guard
    // (writeMemory). The predicate MIRRORS the guard exactly (active row ==
    // valid_to IS NULL) so two concurrent identical remember() calls cannot
    // both pass the SELECT and both INSERT under READ COMMITTED — the second
    // INSERT now violates the constraint and surfaces DuplicateMemoryError.
    // Partial (not full) UNIQUE preserves append-and-supersede (docs/concepts/memory-model.mdx): a
    // re-asserted memory may follow a superseded one (valid_to set), so only
    // the LIVE row per (user_id, content_hash) is constrained. Still serves
    // idempotent-backfill detection — it indexes the same columns.
    uniqueIndex('memories_hash_idx').on(t.userId, t.contentHash).where(sql`${t.validTo} IS NULL`),
    // Containment-query index for tag filtering (`tags @> '["x"]'`). jsonb_path_ops
    // is the narrower, faster operator class for @> at the cost of dropping key-exists
    // (?) support we do not need — tags are values, never keys.
    index('memories_tags_idx').using('gin', t.tags.op('jsonb_path_ops')),
    index('memories_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    // Recency-ordered reads: listMemories and briefing liveMemoriesByType
    // both scan a tenant's rows ORDER BY recorded_at DESC. The index column ordering
    // must match the query's ORDER BY *including NULLS placement*, or the planner falls
    // back to Seq Scan + Sort. `DESC` defaults to NULLS LAST in an index but NULLS FIRST
    // in an ORDER BY, so the NULLS FIRST is explicit here to align the two (recorded_at
    // is NOT NULL, so this is a planner-matching concern, not a data one). id is the
    // stable tiebreaker both call sites use; the briefing's ASC-id variant matches
    // directly, the dashboard's DESC-id variant still uses the index for the leading
    // recorded_at ordering and only re-sorts within equal-timestamp ties.
    index('memories_recorded_at_idx').on(t.userId, t.recordedAt.desc().nullsFirst(), t.id),
    check('memories_type_check', enumCheckSql(t.memoryType, memoryTypeSchema.options)),
    check('memories_status_check', enumCheckSql(t.status, memoryStatusSchema.options)),
    check('memories_validity_check', sql`${t.validTo} IS NULL OR ${t.validFrom} <= ${t.validTo}`),
    tenantPolicy(),
  ],
)

export const memoryEdges = pgTable(
  'memory_edges',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fromId: uuid('from_id').notNull(),
    toId: uuid('to_id').notNull(),
    edgeType: text('edge_type').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // cross-tenant edges are UNREPRESENTABLE: both endpoints must share user_id
    foreignKey({
      name: 'memory_edges_from_fk',
      columns: [t.userId, t.fromId],
      foreignColumns: [memories.userId, memories.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'memory_edges_to_fk',
      columns: [t.userId, t.toId],
      foreignColumns: [memories.userId, memories.id],
    }).onDelete('cascade'),
    uniqueIndex('memory_edges_unique_idx').on(t.userId, t.fromId, t.toId, t.edgeType),
    check('memory_edges_no_self_check', sql`${t.fromId} <> ${t.toId}`),
    check('memory_edges_type_check', enumCheckSql(t.edgeType, edgeTypeSchema.options)),
    check('memory_edges_actor_check', enumCheckSql(t.createdBy, actorKindSchema.options)),
    tenantPolicy(),
  ],
)

// Append-only audit trail — INSERT-only grant for the runtime role (provision-roles.sql).
export const memoryEvents = pgTable(
  'memory_events',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    memoryId: uuid('memory_id').notNull(),
    eventKind: text('event_kind').notNull(),
    actorKind: text('actor_kind').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'memory_events_memory_fk',
      columns: [t.userId, t.memoryId],
      foreignColumns: [memories.userId, memories.id],
    }).onDelete('cascade'),
    index('memory_events_memory_idx').on(t.userId, t.memoryId, t.createdAt),
    check('memory_events_kind_check', enumCheckSql(t.eventKind, eventKindSchema.options)),
    check('memory_events_actor_check', enumCheckSql(t.actorKind, actorKindSchema.options)),
    tenantPolicy(),
  ],
)

// Commitments are their own entity with an explicit FSM (fixes a modeling tangle).
// Transition legality is enforced by a trigger generated from
// COMMITMENT_TRANSITIONS — see migrations + test/transitions.test.ts.
export const commitments = pgTable(
  'commitments',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    memoryId: uuid('memory_id').notNull(),
    status: text('status').notNull().default('open'),
    owner: text('owner'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    recurrence: jsonb('recurrence'),
    nextSurfacingAt: timestamp('next_surfacing_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'commitments_memory_fk',
      columns: [t.userId, t.memoryId],
      foreignColumns: [memories.userId, memories.id],
    }).onDelete('cascade'),
    uniqueIndex('commitments_memory_idx').on(t.userId, t.memoryId),
    index('commitments_surfacing_idx').on(t.userId, t.status, t.nextSurfacingAt),
    check('commitments_status_check', enumCheckSql(t.status, commitmentStatusSchema.options)),
    tenantPolicy(),
  ],
)

export const facts = pgTable(
  'facts',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    memoryId: uuid('memory_id').notNull(),
    subject: text('subject').notNull(),
    predicate: text('predicate').notNull(),
    value: text('value').notNull(),
    confidence: real('confidence'),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'facts_memory_fk',
      columns: [t.userId, t.memoryId],
      foreignColumns: [memories.userId, memories.id],
    }).onDelete('cascade'),
    // No uniqueness on (subject, predicate): bi-temporal history keeps every
    // assertion; "currently true" is a validity query, not a constraint.
    index('facts_subject_idx').on(t.userId, t.subject, t.predicate),
    check('facts_validity_check', sql`${t.validTo} IS NULL OR ${t.validFrom} <= ${t.validTo}`),
    tenantPolicy(),
  ],
)

export const consolidationProposals = pgTable(
  'consolidation_proposals',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fromId: uuid('from_id').notNull(),
    toId: uuid('to_id').notNull(),
    edgeType: text('edge_type').notNull(),
    // S1 graduates: per-type precision must be auditable
    memoryType: text('memory_type').notNull(),
    similarity: real('similarity').notNull(),
    rationale: text('rationale'),
    status: text('status').notNull().default('proposed'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'proposals_from_fk',
      columns: [t.userId, t.fromId],
      foreignColumns: [memories.userId, memories.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'proposals_to_fk',
      columns: [t.userId, t.toId],
      foreignColumns: [memories.userId, memories.id],
    }).onDelete('cascade'),
    // one OPEN proposal per candidate edge; re-proposal after rejection allowed
    uniqueIndex('proposals_open_idx')
      .on(t.userId, t.fromId, t.toId, t.edgeType)
      .where(sql`status = 'proposed'`),
    index('proposals_review_idx').on(t.userId, t.status, t.createdAt),
    check('proposals_edge_check', enumCheckSql(t.edgeType, edgeTypeSchema.options)),
    check('proposals_type_check', enumCheckSql(t.memoryType, memoryTypeSchema.options)),
    check('proposals_status_check', enumCheckSql(t.status, proposalStatusSchema.options)),
    tenantPolicy(),
  ],
)

// Staging area for extracted facts: a candidate stays here until a human
// accepts it, so nothing an extractor produced becomes queryable truth in
// `facts` without review. A sibling table rather than a discriminator column on
// consolidation_proposals — edge proposals and fact proposals share only a
// status FSM, and folding them together would force relaxing shipped NOT NULLs
// on a table whose insert path is already load-bearing (ADR-0011: compose
// beside shipped objects, never reshape them).
export const factProposals = pgTable(
  'fact_proposals',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    memoryId: uuid('memory_id').notNull(),
    subject: text('subject').notNull(),
    predicate: text('predicate').notNull(),
    value: text('value').notNull(),
    confidence: real('confidence'),
    // Nullable unlike facts.valid_from: an extractor often cannot date an
    // assertion, and the reviewer supplies the window on accept. facts keeps
    // its NOT NULL default now() — a proposal is not yet an assertion.
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),
    // Mirrors consolidation_proposals.memory_type: per-type precision of the
    // extractor must be auditable before any of it is trusted.
    memoryType: text('memory_type').notNull(),
    rationale: text('rationale'),
    status: text('status').notNull().default('proposed'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'fact_proposals_memory_fk',
      columns: [t.userId, t.memoryId],
      foreignColumns: [memories.userId, memories.id],
    }).onDelete('cascade'),
    // one OPEN proposal per candidate fact; re-proposal after rejection allowed
    // (mirrors proposals_open_idx). The eventual insert path's ON CONFLICT
    // target must byte-mirror these columns and this predicate.
    uniqueIndex('fact_proposals_open_idx')
      .on(t.userId, t.memoryId, t.subject, t.predicate, t.value)
      .where(sql`status = 'proposed'`),
    index('fact_proposals_review_idx').on(t.userId, t.status, t.createdAt),
    check('fact_proposals_type_check', enumCheckSql(t.memoryType, memoryTypeSchema.options)),
    check('fact_proposals_status_check', enumCheckSql(t.status, proposalStatusSchema.options)),
    // Same shape as facts_validity_check and nullable-tolerant by construction:
    // with valid_from NULL the comparison is NULL, which a CHECK does not treat
    // as a violation.
    check(
      'fact_proposals_validity_check',
      sql`${t.validTo} IS NULL OR ${t.validFrom} <= ${t.validTo}`,
    ),
    tenantPolicy(),
  ],
)

export const scopes = pgTable(
  'scopes',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    aliases: jsonb('aliases').notNull().default([]).$type<string[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('scopes_name_idx').on(t.userId, t.name), tenantPolicy()],
)
