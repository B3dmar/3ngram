// SPDX-License-Identifier: Apache-2.0
// handoff(): export structured context for ANOTHER agent/provider.
// The policy surface for the "carry context
// to another tool/agent" JTBD.
//
// apps -> core -> db layering (hard rule 5): REUSES the briefing-read.ts
// aggregation queries (no duplicated SQL) inside ONE withTenant transaction (hard
// rule 3). Selector discipline is SHARED with briefing() via requireSelector():
// a handoff also REQUIRES an explicit selector (no-firehose).
//
// CONTENT-INCLUDED-BY-DESIGN (the key difference from logs, hard rule 6): a
// briefing's sections carry topic/ids only; a HANDOFF carries memory CONTENT,
// because its whole purpose is to TRANSPORT context to a receiving agent — a
// handoff without content is useless. This is NOT a hard-rule-6 violation: rule 6
// forbids content in LOGS/TRACES/METRICS, an OBSERVABILITY sink. A handoff is a
// deliberate DATA EXPORT to an authenticated caller over the same RLS-scoped path
// every read uses — the content never enters a log here (this module logs
// nothing) and the transport must never log the handoff payload either. The
// payload stays BOUNDED (per-section MAX) so it is an export, not a firehose.
//
// INJECTED TIME (no datetime.now()): the caller passes `now`; the commitment list
// (open/waiting) is read against it, same as briefing().
//
// Observability (hard rule 6): this module logs NOTHING. Callers MUST NOT log the
// returned payload — it carries content by design (see header).
import {
  activePreferences,
  type BriefingMemoryRow,
  type BriefingSelector,
  openCommitments,
  recentDecisions,
  withTenant,
} from '@3ngram/db'
import { requireSelector, type BriefingSelector as Selector } from './briefing.js'
import { excerptContent } from './excerpt.js'

export type { BriefingSelector } from '@3ngram/db'

/**
 * Per-section ceiling for a handoff export. Bounded (no-firehose) even though a
 * handoff intentionally carries content: it is an EXPORT for a receiving agent,
 * not a full dump. A receiver needing more pages via search/get_facts.
 */
export const MAX_HANDOFF_SECTION = 25

/** Inputs for {@link handoff}. `now` is injected (no wall-clock read in core). */
export interface HandoffQuery {
  selector: BriefingSelector | undefined
  /** Optional free-form label for the receiving agent (echoed back; never logged). */
  generatedFor?: string | undefined
  now: Date
}

/**
 * A decision/preference line in a handoff — CONTENT INCLUDED by design (see
 * header), as a bounded EXCERPT (imported rows can exceed any
 * write-time cap; the schema handoffMemorySchema bounds per-line content).
 * `contentLength` is the FULL stored length; `truncated` flags a cut excerpt.
 */
export interface HandoffMemory {
  id: string
  memoryType: string
  topic: string
  content: string
  contentLength: number
  truncated: boolean
  scope: string
  project: string | null
}

/** A commitment line in a handoff (ids/topic/status/due — the obligation to carry). */
export interface HandoffCommitment {
  id: string
  memoryId: string
  topic: string
  status: string
  dueAt: string | null
}

/**
 * The structured handoff: the selector echoed back, an optional
 * `generatedFor` label, and the bounded context lists a receiving agent needs to
 * pick up the thread — decisions, open commitments, preferences. `notes` is a
 * reserved free-form list (currently empty) for future curated additions; it
 * keeps the shape stable for the receiver.
 *
 * CONTENT IS INCLUDED here by design (decisions/preferences carry `content`) —
 * the difference from a briefing and from logs (see module header).
 */
export interface Handoff {
  selector: BriefingSelector
  generatedFor: string | null
  generatedAt: string
  decisions: HandoffMemory[]
  commitments: HandoffCommitment[]
  preferences: HandoffMemory[]
  notes: string[]
}

function toHandoffMemory(row: BriefingMemoryRow): HandoffMemory {
  // Read-path excerpting (docs/concepts/architecture.mdx): bound the content here in core
  // — same policy as search hits — so the MCP transport's output schema
  // (handoffMemorySchema) never rejects a legitimately stored long row.
  return {
    id: row.id,
    memoryType: row.memoryType,
    topic: row.topic,
    ...excerptContent(row.content),
    scope: row.scope,
    project: row.project,
  }
}

/**
 * Build the structured handoff for `userId`.
 *
 * REQUIRES an explicit selector (no-firehose, shared {@link requireSelector} with
 * briefing()): omit it and the call throws MissingSelectorError. REUSES the
 * briefing-read.ts queries (recentDecisions / openCommitments / activePreferences)
 * — no duplicated SQL — inside ONE withTenant transaction. Every section is
 * bounded by {@link MAX_HANDOFF_SECTION}.
 *
 * The payload carries memory CONTENT by design (a handoff transports context);
 * the caller MUST NOT log it (header).
 *
 * @throws MissingSelectorError no selector / empty scope|project value.
 */
export async function handoff(userId: string, query: HandoffQuery): Promise<Handoff> {
  const selector: Selector = requireSelector(query.selector)
  const limit = MAX_HANDOFF_SECTION

  // The briefing-read queries return {items, totalCount} (a window count rides each
  // statement for the briefing's exact-count contract); a handoff only needs the
  // bounded item slices, so it reads `.items` and ignores the count.
  const { decisionRows, commitmentRows, preferenceRows } = await withTenant(userId, async (tx) => ({
    decisionRows: (await recentDecisions(tx, selector, limit)).items,
    commitmentRows: (await openCommitments(tx, selector, limit)).items,
    preferenceRows: (await activePreferences(tx, selector, limit)).items,
  }))

  return {
    selector,
    generatedFor: query.generatedFor ?? null,
    generatedAt: query.now.toISOString(),
    decisions: decisionRows.map(toHandoffMemory),
    commitments: commitmentRows.map((row) => ({
      id: row.id,
      memoryId: row.memoryId,
      topic: row.topic,
      status: row.status,
      dueAt: row.dueAt?.toISOString() ?? null,
    })),
    preferences: preferenceRows.map(toHandoffMemory),
    notes: [],
  }
}
