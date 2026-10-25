// SPDX-License-Identifier: Apache-2.0
// Complete, read-only pagination for proposal review (issue #320): the shared
// pieces both the MCP `review_proposals` list and REST `GET /api/v1/proposals`
// compose — the opaque `cursor` input field and the per-kind count shape.
//
// THE CONTRACT (one keyset over the merged proposal stream):
//
// - ORDER: every kind the listing covers is merged into ONE total order,
//   `created_at DESC, id DESC`. Proposal ids are uuidv7 drawn from disjoint
//   tables, so `id` breaks every tie — including a same-transaction batch whose
//   rows share one `now()` timestamp, and ties ACROSS kinds.
// - PAGE: at most `limit` rows across all kinds, taken from the head of that
//   merged order after the cursor position. Neither kind can starve the other
//   for a whole walk: a burst of one kind fills pages in creation order, and
//   the walk reaches the other kind's rows exactly where they fall. A third
//   proposal kind (e.g. resolution proposals, issue #229) joins by adding one
//   more keyset source to the merge and one more key to `counts`/`totals`; the
//   cursor payload does not change, because a position in the merged order is
//   still just `(createdAt, id)`.
// - CONTINUATION: `nextCursor` is present exactly when `hasMore` is true. It is
//   bound (by a hash fingerprint) to the surface, the kinds walked, the status
//   filter, the order, and the tenant; a token replayed under a different
//   binding, or a garbled token, is rejected as invalid input — never silently
//   restarted at page 1.
//
// LIVE-VIEW SEMANTICS (the keyset walks the live tables, nothing is frozen):
//
// (a) No id is ever returned twice in one walk: each page resumes strictly
//     after the last emitted `(createdAt, id)`, and neither coordinate of a row
//     ever changes.
// (b) A row decided (accepted/rejected) mid-walk that thereby leaves the status
//     filter is simply not returned if the walk has not reached it yet; no
//     other row is skipped or repeated because of it. Without a status filter
//     it is returned with its CURRENT status.
// (c) A row created after the walk started sorts NEWER than every cursor
//     position (creation time only moves forward), so it is not seen until a
//     fresh walk starts from page 1.
// (d) `totals` is the live matching count AS OF THIS PAGE'S READ — taken in the
//     same read-only, repeatable-read transaction as the page rows, so a page
//     and its totals agree, but totals are NOT frozen across pages and can move
//     between them as proposals are created or decided.
//
// Listing is a pure read: it runs in a READ ONLY transaction, so it cannot
// change proposal or memory state, and no proposal content or rationale is
// logged (hard rule 6).
import { z } from 'zod'
import { OPEN_OUTPUT_META } from './output-openness.js'

/** Upper bound on an opaque proposals cursor token (a v4 payload is ~150 chars). */
const MAX_PROPOSALS_CURSOR_LENGTH = 512

/**
 * The opaque continuation token a previous page returned as `nextCursor`.
 * Validated ON DECODE in apps/server (shape + fingerprint); here it is a
 * bounded non-empty string.
 */
export const proposalsCursorSchema = z
  .string()
  .min(1)
  .max(MAX_PROPOSALS_CURSOR_LENGTH)
  .describe(
    'Opaque continuation token from a previous page’s nextCursor. Omit for the first page. Keep status identical across pages of one walk.',
  )

/** A non-negative per-kind row count. */
const kindCount = z.number().int().min(0)

/**
 * Per-kind counts for the MCP list (both kinds). Used twice: `counts` (rows on
 * THIS page) and `totals` (all rows matching the status filter, live as of this
 * page's read — see the module header, item (d)).
 */
export const proposalKindCountsSchema = z
  .object({ edge: kindCount, fact: kindCount })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type ProposalKindCounts = z.infer<typeof proposalKindCountsSchema>

/** REST edge-only totals (`GET /api/v1/proposals` walks edge proposals only). */
export const proposalEdgeTotalsSchema = z
  .object({ edge: kindCount })
  .strict()
  .meta(OPEN_OUTPUT_META)
export type ProposalEdgeTotals = z.infer<typeof proposalEdgeTotalsSchema>
