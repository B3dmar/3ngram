// SPDX-License-Identifier: Apache-2.0
// Opaque cursor CONTRACT for dashboard search continuation.
//
// v2 (frozen ordering): the first page ranks the bounded candidate
// pool ONCE and freezes that ranked ordering into the cursor as a parallel
// (`ids`, `scores`) list plus an `off`set; continuation pages page BY POSITION
// within the frozen ordering. This is immune to BOTH duplicates and skips even
// when fusion scores drift between requests (window-relative FTS normalization,
// now()-based recency) — the v1 keyset cursor pinned the drifting
// (score, id) of the last row and so could repeat or skip a row whose score
// crossed the saved boundary mid-session.
//
// Cursor size is bounded because the pageable set is the candidate pool
// (`max(limit*4, 50)`, ~100 for the dashboard), which also preserves the
// existing deep-paging cap.
//
// Only the PAYLOAD SHAPE lives here (the ONE validation boundary, hard rule 2).
// The opaque base64url encode/decode is Node-side and lives in apps/server
// (apps/server/src/cursor.ts, shared by REST and MCP) so this package stays
// dependency-light (zod only — no @types/node). Clients treat the token as
// opaque and never decode it.
import { z } from 'zod'
import { exceedsRecordedBoundPrecision } from './recorded-range.js'
import { scopeSchema } from './scope.js'

/** Upper bound on the frozen ordering carried in the cursor (candidate-pool sized). */
const MAX_FROZEN_ORDERING = 1000

/** The `fp` fingerprint shape shared by every cursor variant (truncated sha256, hex). */
const fingerprintField = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .optional()

/**
 * Decoded frozen-ordering cursor (v2): the page-1 ranked candidate ordering
 * (`ids` + parallel `scores`) and the position (`off`) of the next page within
 * it. `ids.length === scores.length`; `0 <= off <= ids.length`.
 *
 * `fp` binds the cursor to the search that issued it: a short stable hash
 * (truncated sha256, hex) of the normalized query + filter set, computed by the
 * shared codec (apps/server/src/cursor.ts searchFingerprint). Issuance
 * populates it; continuation verifies it and rejects a cursor replayed against
 * a DIFFERENT query/filters with a typed invalid-input error — never silently
 * re-paging the frozen ids of the old search. COMPATIBILITY: the field is
 * OPTIONAL with verify-when-present semantics — a v2 cursor minted before this
 * field existed carries no `fp` and stays valid (no mid-session invalidation
 * across the deploy boundary).
 *
 * `policyScope` binds the frozen ordering to the nullable scope applied by the
 * retrieval policy on page 1. New cursors always carry it; absence denotes a
 * legacy v2 token minted before the binding was added.
 */
export const cursorPayloadV2Schema = z
  .object({
    v: z.literal(2),
    ids: z.array(z.uuid()).max(MAX_FROZEN_ORDERING),
    scores: z.array(z.number()).max(MAX_FROZEN_ORDERING),
    off: z.number().int().min(0),
    fp: fingerprintField,
    policyScope: scopeSchema.nullable().optional(),
  })
  .strict()
  .refine((p) => p.ids.length === p.scores.length, {
    message: 'cursor ids and scores must be the same length',
  })
  .refine((p) => p.off <= p.ids.length, { message: 'cursor offset out of range' })
export type CursorPayloadV2 = z.infer<typeof cursorPayloadV2Schema>

/**
 * Decoded chronological-list cursor (v3, ADR-0011 union growth — the shipped
 * v2 shape above stays byte-identical). List mode has no ranked pool to
 * freeze: the position is a KEYSET on the chronological total order
 * (`recorded_at DESC, id DESC`), so the payload is just the last-seen row's
 * coordinates — tiny compared to v2's frozen ids+scores arrays, and, because
 * `recorded_at` never changes after insert (unlike a fused score), immune to
 * the drift a v2 keyset would need the frozen pool to guard against.
 *
 * `recordedAt` carries the SAME millisecond-precision cap as the
 * recordedAfter/recordedBefore filter bounds (recorded-range.ts): it is
 * DECODED BACK into a `Date` and bound into SQL as the keyset boundary, so an
 * over-precision value would silently truncate and could shift the boundary —
 * the same inclusive-bound leak issue #58 item 2 fixed for the filter bounds,
 * applied here defensively since the cursor is caller-tamperable (opaque
 * base64, not re-derived server-side).
 *
 * `fp` mirrors v2's binding, but is computed with `order` folded into the
 * hashed filter set (apps/server/src/mcp/tools-search.ts) — v2's fingerprint
 * computation is UNCHANGED (no `order` key), so a pre-existing v2 cursor keeps
 * verifying after this deploy; only the new chronological path adds the
 * discriminator, which is what lets a cursor minted by ONE order mode be
 * rejected (mismatch, not a crash) if replayed against the other.
 */
export const cursorPayloadV3Schema = z
  .object({
    v: z.literal(3),
    recordedAt: z.iso.datetime().refine((iso) => !exceedsRecordedBoundPrecision(iso), {
      message: 'recordedAt precision exceeds milliseconds',
    }),
    id: z.uuid(),
    fp: fingerprintField,
  })
  .strict()
export type CursorPayloadV3 = z.infer<typeof cursorPayloadV3Schema>

/** Either cursor variant: the shipped v2 frozen ordering, or the v3 chronological keyset. */
export const cursorPayloadSchema = z.union([cursorPayloadV2Schema, cursorPayloadV3Schema])
export type CursorPayload = z.infer<typeof cursorPayloadSchema>

/**
 * Legacy v1 keyset cursor ({ s, id }). Detected only so a cursor minted before
 * the v2 deploy gracefully restarts at page 1 instead of erroring mid-session.
 */
export const legacyCursorPayloadSchema = z.object({ s: z.number(), id: z.uuid() }).strict()
