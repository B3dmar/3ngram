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
import { exceedsFractionalSecondPrecision } from './recorded-range.js'
import { scopeSchema } from './scope.js'

/** Upper bound on the frozen ordering carried in the cursor (candidate-pool sized). */
const MAX_FROZEN_ORDERING = 1000

/** Postgres timestamptz's native resolution — see cursorPayloadV3Schema's `recordedAt` doc comment. */
const MAX_CURSOR_RECORDED_AT_FRACTION_DIGITS = 6

/** The bare `fp` shape (truncated sha256, hex), before either variant decides optional/required. */
const fingerprintShape = z.string().regex(/^[0-9a-f]{16}$/)

/** v2's `fp`: OPTIONAL — a legacy token minted before the field existed carries none. */
const fingerprintField = fingerprintShape.optional()

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
 * `recordedAt` is OPAQUE full-precision ISO 8601 text, capped at
 * {@link MAX_CURSOR_RECORDED_AT_FRACTION_DIGITS} (6 — Postgres's OWN
 * microsecond resolution for `timestamptz`), NOT the 3-digit millisecond cap
 * the recordedAfter/recordedBefore FILTER bounds use (recorded-range.ts).
 * That 3-digit cap exists ONLY because those bounds convert through a JS
 * `Date` (millisecond-limited) before reaching SQL — this field NEVER does:
 * the db layer selects it via `to_char(...)` and binds it back as
 * `::timestamptz` verbatim (packages/db/src/search-list.ts), so it carries
 * the SAME precision Postgres itself stores. A 3-digit cap here would
 * REJECT the one representation that round-trips correctly and FORCE
 * millisecond truncation — which silently drops rows: `now()` is
 * transaction-constant, so a same-transaction batch insert gives every row
 * an IDENTICAL microsecond-precision timestamp; truncating the cursor's
 * boundary to milliseconds while the column keeps microseconds can make
 * `recorded_at = cursor.recordedAt` false for a whole tied group that a
 * millisecond-precision cursor can no longer address, silently excluding it
 * from every subsequent page. Still capped (not unbounded) because the
 * cursor is caller-tamperable (opaque base64, not re-derived server-side)
 * and Postgres itself never stores more than 6 digits — issue #58 item 2's
 * inclusive-bound-leak concern, applied at the resolution that is actually
 * real here.
 *
 * `fp` mirrors v2's binding, but is computed with `order` folded into the
 * hashed filter set (apps/server/src/mcp/tools-search.ts) — v2's fingerprint
 * computation is UNCHANGED (no `order` key), so a pre-existing v2 cursor keeps
 * verifying after this deploy; only the new chronological path adds the
 * discriminator, which is what lets a cursor minted by ONE order mode be
 * rejected (mismatch, not a crash) if replayed against the other. UNLIKE v2,
 * `fp` is REQUIRED here: v3 is introduced in this same change, so no
 * fingerprint-less v3 token has ever legitimately existed — v2's optional
 * `fp` is a backward-compatibility carve-out for tokens minted before the
 * field existed, which has no v3 analogue. Requiring it closes a real gap: an
 * optional `fp` (inherited from v2's shape) would let a HAND-STRIPPED v3
 * token bypass the fingerprint mismatch check and fall through to the
 * shape-guard fallback in the transport (apps/server/src/mcp/tools-search.ts,
 * apps/server/src/rest/search-router.ts) — which is a legitimate LAST resort
 * for a genuinely legacy cursor, not a hole a well-formed v3 token should
 * ever need.
 */
export const cursorPayloadV3Schema = z
  .object({
    v: z.literal(3),
    recordedAt: z.iso
      .datetime()
      .refine(
        (iso) => !exceedsFractionalSecondPrecision(iso, MAX_CURSOR_RECORDED_AT_FRACTION_DIGITS),
        { message: 'recordedAt precision exceeds microseconds' },
      ),
    id: z.uuid(),
    fp: fingerprintShape,
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
