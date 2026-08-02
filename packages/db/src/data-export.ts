// SPDX-License-Identifier: Apache-2.0
// Full-account data-export read (GDPR Art. 20 portability). SQL ONLY
// (hard rule 5): the core wrapper (read/export.ts) owns the withTenant boundary
// and the envelope shaping; transports stay thin.
//
// UNBOUNDED BY DESIGN: unlike the dashboard list (memory-read.ts, LIVE-only +
// paged), a portability export must return EVERY row the user owns — including
// superseded memories and closed bi-temporal fact generations (docs/concepts/memory-model.mdx keeps
// them; the export must too). It is therefore deliberately not paged. TENANT
// ISOLATION IS TWO-LAYER (defense in depth): each table read runs inside
// withTenant(), where RLS scopes the tenant-owned tables to the caller, AND
// carries an explicit caller-bound `user_id = userId` predicate (the same userId
// the caller passed into withTenant(), facts-read.ts precedent) — an export
// aggregates a tenant's ENTIRE dataset, so its isolation must never rest on a
// single mechanism. The `users` table is the pre-tenant SYSTEM table (no RLS)
// and is keyed by id = userId, exactly as users-read.ts does for /me.
//
// CONSISTENT SNAPSHOT: the multi-table read is correct only under a single
// snapshot — under READ COMMITTED a concurrent write/import between SELECTs could
// surface a dangling child (e.g. a fact whose parent memory is unseen) or
// mismatched counts. The core wrapper (read/export.ts) runs this whole function
// in ONE `{ isolationLevel: 'repeatable read' }` withTenant transaction, so every
// SELECT below shares one snapshot.
//
// COMPLETENESS: includes the OTHER tenant PII the model stores — `memory_events`
// (append-only audit payloads from imports) and `consolidation_proposals`
// (generated rationales) — AND the typed memory graph: `memory_edges`
// (supersedes/updates/extends/derives, docs/concepts/memory-model.mdx), so the archive captures the
// user's memory STRUCTURE, not just isolated rows. The runtime role has SELECT on
// all three; export is read-only, so the append-only grant is irrelevant here.
// Also includes the user-owned COST/USAGE rows — `user_budgets` and `llm_usage` —
// both RLS-scoped (tenantPolicy) so they share the same caller-only guarantee. An
// optional {@link ExportEnricher} (injected by a platform extension) can merge
// additional user-owned rows into the archive; self-host adds none.
//
// Content discipline (hard rule 6): this layer returns content/topic/subject/
// value to assemble the OWNER's own export (its JTBD, like getMemoryById) but
// logs NOTHING; callers log ids/counts only and never the password hash, which is
// never selected here.
import { asc, eq } from 'drizzle-orm'
import type { TenantTx } from './client.js'
import { userBudgets } from './schema/budget.js'
import { userProfileAttributes, users } from './schema/identity.js'
import {
  commitments,
  consolidationProposals,
  facts,
  memories,
  memoryEdges,
  memoryEvents,
  scopes,
} from './schema/memory.js'
import { llmUsage } from './schema/ops.js'

/** The account identity for an export — never the password hash. */
export interface ExportAccountRow {
  id: string
  email: string
  emailVerifiedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** A full memory row for an export (every lifecycle state, content included). */
export interface ExportMemoryRow {
  id: string
  memoryType: string
  topic: string
  content: string
  scope: string
  project: string | null
  status: string
  tags: string[]
  validFrom: Date
  validTo: Date | null
  recordedAt: Date
  createdAt: Date
  updatedAt: Date
}

/** A full fact row for an export (every bi-temporal generation). */
export interface ExportFactRow {
  id: string
  memoryId: string
  subject: string
  predicate: string
  value: string
  confidence: number | null
  validFrom: Date
  validTo: Date | null
  recordedAt: Date
  createdAt: Date
}

/** A full commitment row for an export. */
export interface ExportCommitmentRow {
  id: string
  memoryId: string
  status: string
  owner: string | null
  dueAt: Date | null
  recurrence: unknown
  nextSurfacingAt: Date | null
  resolvedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** A scope (user-defined label set) row for an export. */
export interface ExportScopeRow {
  id: string
  name: string
  aliases: string[]
  createdAt: Date
}

/** A memory-event audit row for an export — includes the (PII-bearing) payload. */
export interface ExportMemoryEventRow {
  id: string
  memoryId: string
  eventKind: string
  actorKind: string
  payload: unknown
  createdAt: Date
}

/** A typed memory-graph edge for an export (supersedes/updates/extends/derives). */
export interface ExportEdgeRow {
  id: string
  fromId: string
  toId: string
  edgeType: string
  createdBy: string
  createdAt: Date
}

/** A consolidation-proposal row for an export — includes the (PII-bearing) rationale. */
export interface ExportProposalRow {
  id: string
  fromId: string
  toId: string
  edgeType: string
  memoryType: string
  similarity: number
  rationale: string | null
  status: string
  decidedAt: Date | null
  createdAt: Date
}

/**
 * A user-budget row for an export — the period window + optional operator cap
 * override. `capUsdOverride` is the numeric(20,12) column surfaced as a
 * decimal string (drizzle), NULL meaning "use the tier cap". One row per user.
 */
export interface ExportBudgetRow {
  id: string
  capUsdOverride: string | null
  periodStart: Date | null
  periodEnd: Date | null
  updatedAt: Date
}

/**
 * An llm_usage row for an export — per-call cost/token accounting. Carries
 * operation/model/token counts/cost ONLY — never embedded text or vectors (hard
 * rule 6). `costUsd` is the numeric(20,12) column as a decimal string (drizzle).
 */
export interface ExportLlmUsageRow {
  id: string
  operation: string
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: string | null
  createdAt: Date
}

/** Onboarding "About you" profiling row for a portability export. */
export interface ExportUserProfileRow {
  role: string | null
  useCase: string | null
  aiTools: string[] | null
  referralSource: string | null
  createdAt: Date
  updatedAt: Date
}

/** The complete user-owned dataset for a portability export. */
export interface UserDataExport {
  account: ExportAccountRow
  memories: ExportMemoryRow[]
  facts: ExportFactRow[]
  commitments: ExportCommitmentRow[]
  scopes: ExportScopeRow[]
  edges: ExportEdgeRow[]
  memoryEvents: ExportMemoryEventRow[]
  proposals: ExportProposalRow[]
  userBudgets: ExportBudgetRow[]
  llmUsage: ExportLlmUsageRow[]
  /** Onboarding profiling; null if the user never answered. */
  profile: ExportUserProfileRow | null
}

/**
 * Injected hook that returns ADDITIONAL user-owned rows to merge into the export
 * (e.g. platform-specific records), keyed by field name. Runs inside the SAME
 * withTenant snapshot transaction. Self-host injects none, so the base archive is
 * returned unchanged.
 */
export type ExportEnricher = (tx: TenantTx, userId: string) => Promise<Record<string, unknown>>

/**
 * Read the complete user-owned dataset for `userId` inside one withTenant
 * transaction so the export is a consistent snapshot. RLS plus the explicit
 * caller-bound `user_id = userId` predicate on every tenant-table read scope the
 * archive to the caller (module header); the `users` row is keyed by id. The account
 * row is an INVARIANT (the caller just authenticated as this id) — its absence is
 * thrown by the core wrapper, not handled here.
 *
 * When `enrich` is supplied, its extra fields are merged over the base archive in
 * the same transaction (self-host passes none, so the base is returned unchanged).
 *
 * @param tx      The withTenant transaction (RLS context already established).
 * @param userId  The authenticated tenant whose `users` row is keyed by id.
 * @param enrich  Optional platform hook adding extra user-owned rows.
 */
export async function readUserDataExport(
  tx: TenantTx,
  userId: string,
  enrich?: ExportEnricher,
): Promise<UserDataExport | undefined> {
  const [account] = await tx
    .select({
      id: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (account === undefined) return undefined

  const memoryRows = await tx
    .select({
      id: memories.id,
      memoryType: memories.memoryType,
      topic: memories.topic,
      content: memories.content,
      scope: memories.scope,
      project: memories.project,
      status: memories.status,
      tags: memories.tags,
      validFrom: memories.validFrom,
      validTo: memories.validTo,
      recordedAt: memories.recordedAt,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .where(eq(memories.userId, userId))
    .orderBy(asc(memories.createdAt), asc(memories.id))

  const factRows = await tx
    .select({
      id: facts.id,
      memoryId: facts.memoryId,
      subject: facts.subject,
      predicate: facts.predicate,
      value: facts.value,
      confidence: facts.confidence,
      validFrom: facts.validFrom,
      validTo: facts.validTo,
      recordedAt: facts.recordedAt,
      createdAt: facts.createdAt,
    })
    .from(facts)
    .where(eq(facts.userId, userId))
    .orderBy(asc(facts.createdAt), asc(facts.id))

  const commitmentRows = await tx
    .select({
      id: commitments.id,
      memoryId: commitments.memoryId,
      status: commitments.status,
      owner: commitments.owner,
      dueAt: commitments.dueAt,
      recurrence: commitments.recurrence,
      nextSurfacingAt: commitments.nextSurfacingAt,
      resolvedAt: commitments.resolvedAt,
      createdAt: commitments.createdAt,
      updatedAt: commitments.updatedAt,
    })
    .from(commitments)
    .where(eq(commitments.userId, userId))
    .orderBy(asc(commitments.createdAt), asc(commitments.id))

  const scopeRows = await tx
    .select({
      id: scopes.id,
      name: scopes.name,
      aliases: scopes.aliases,
      createdAt: scopes.createdAt,
    })
    .from(scopes)
    .where(eq(scopes.userId, userId))
    .orderBy(asc(scopes.name))

  const edgeRows = await tx
    .select({
      id: memoryEdges.id,
      fromId: memoryEdges.fromId,
      toId: memoryEdges.toId,
      edgeType: memoryEdges.edgeType,
      createdBy: memoryEdges.createdBy,
      createdAt: memoryEdges.createdAt,
    })
    .from(memoryEdges)
    .where(eq(memoryEdges.userId, userId))
    .orderBy(asc(memoryEdges.createdAt), asc(memoryEdges.id))

  const eventRows = await tx
    .select({
      id: memoryEvents.id,
      memoryId: memoryEvents.memoryId,
      eventKind: memoryEvents.eventKind,
      actorKind: memoryEvents.actorKind,
      payload: memoryEvents.payload,
      createdAt: memoryEvents.createdAt,
    })
    .from(memoryEvents)
    .where(eq(memoryEvents.userId, userId))
    .orderBy(asc(memoryEvents.createdAt), asc(memoryEvents.id))

  const proposalRows = await tx
    .select({
      id: consolidationProposals.id,
      fromId: consolidationProposals.fromId,
      toId: consolidationProposals.toId,
      edgeType: consolidationProposals.edgeType,
      memoryType: consolidationProposals.memoryType,
      similarity: consolidationProposals.similarity,
      rationale: consolidationProposals.rationale,
      status: consolidationProposals.status,
      decidedAt: consolidationProposals.decidedAt,
      createdAt: consolidationProposals.createdAt,
    })
    .from(consolidationProposals)
    .where(eq(consolidationProposals.userId, userId))
    .orderBy(asc(consolidationProposals.createdAt), asc(consolidationProposals.id))

  const budgetRows = await tx
    .select({
      id: userBudgets.id,
      capUsdOverride: userBudgets.capUsdOverride,
      periodStart: userBudgets.periodStart,
      periodEnd: userBudgets.periodEnd,
      updatedAt: userBudgets.updatedAt,
    })
    .from(userBudgets)
    .where(eq(userBudgets.userId, userId))
    .orderBy(asc(userBudgets.updatedAt), asc(userBudgets.id))

  const usageRows = await tx
    .select({
      id: llmUsage.id,
      operation: llmUsage.operation,
      model: llmUsage.model,
      inputTokens: llmUsage.inputTokens,
      outputTokens: llmUsage.outputTokens,
      costUsd: llmUsage.costUsd,
      createdAt: llmUsage.createdAt,
    })
    .from(llmUsage)
    .where(eq(llmUsage.userId, userId))
    .orderBy(asc(llmUsage.createdAt), asc(llmUsage.id))

  const [profileRow] = await tx
    .select({
      role: userProfileAttributes.role,
      useCase: userProfileAttributes.useCase,
      aiTools: userProfileAttributes.aiTools,
      referralSource: userProfileAttributes.referralSource,
      createdAt: userProfileAttributes.createdAt,
      updatedAt: userProfileAttributes.updatedAt,
    })
    .from(userProfileAttributes)
    .where(eq(userProfileAttributes.userId, userId))
    .limit(1)

  const base: UserDataExport = {
    account,
    memories: memoryRows,
    facts: factRows,
    commitments: commitmentRows,
    scopes: scopeRows,
    edges: edgeRows,
    memoryEvents: eventRows,
    proposals: proposalRows,
    userBudgets: budgetRows,
    llmUsage: usageRows,
    profile: profileRow ?? null,
  }
  if (enrich === undefined) return base
  // Merge the platform hook's extra user-owned rows over the base archive in the
  // same snapshot. The extras are runtime-only (self-host adds none).
  return { ...base, ...(await enrich(tx, userId)) } as UserDataExport
}
