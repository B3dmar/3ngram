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
// (apps/server/src/rest/cursor.ts) so this package stays dependency-light (zod
// only — no @types/node). The browser treats the token as opaque and never
// decodes it.
import { z } from 'zod'

/** Upper bound on the frozen ordering carried in the cursor (candidate-pool sized). */
const MAX_FROZEN_ORDERING = 1000

/**
 * Decoded frozen-ordering cursor (v2): the page-1 ranked candidate ordering
 * (`ids` + parallel `scores`) and the position (`off`) of the next page within
 * it. `ids.length === scores.length`; `0 <= off <= ids.length`.
 */
export const cursorPayloadSchema = z
  .object({
    v: z.literal(2),
    ids: z.array(z.uuid()).max(MAX_FROZEN_ORDERING),
    scores: z.array(z.number()).max(MAX_FROZEN_ORDERING),
    off: z.number().int().min(0),
  })
  .strict()
  .refine((p) => p.ids.length === p.scores.length, {
    message: 'cursor ids and scores must be the same length',
  })
  .refine((p) => p.off <= p.ids.length, { message: 'cursor offset out of range' })
export type CursorPayload = z.infer<typeof cursorPayloadSchema>

/**
 * Legacy v1 keyset cursor ({ s, id }). Detected only so a cursor minted before
 * the v2 deploy gracefully restarts at page 1 instead of erroring mid-session.
 */
export const legacyCursorPayloadSchema = z.object({ s: z.number(), id: z.uuid() }).strict()
