// SPDX-License-Identifier: Apache-2.0
// Read-path content excerpting. POLICY, not transport logic
// (docs/concepts/architecture.mdx: one core, N transports — REST and MCP inherit the bounded shape
// from core, so the surfaces cannot drift).
//
// WHY: native writes cap content at 2,000 chars, but the IMPORT path admits up
// to 262,144 (packages/schema/src/import.ts) — the migration landed rows
// far over any write-time bound. Read surfaces whose output contracts bound
// per-item content (search hits, handoff lines) must therefore EXCERPT, or a
// single long row fails output validation for the whole read. The cap is frozen
// at the ONE validation boundary (packages/schema MAX_EXCERPT_LENGTH, hard rule
// 2); this module only APPLIES it.
//
// docs/concepts/memory-model.mdx (append-and-supersede): excerpting is READ-SIDE shaping only — the
// stored row is never touched. The full content stays retrievable by id (the
// REST memory detail is unbounded by design); `contentLength` + `truncated`
// tell a caller when to fetch it.
import { EXCERPT_MARKER, MAX_EXCERPT_LENGTH } from '@3ngram/schema'

/** A read-result content excerpt: the bounded text + the full-length metadata. */
export interface ExcerptedContent {
  /** At most MAX_EXCERPT_LENGTH chars; ends with EXCERPT_MARKER when truncated. */
  content: string
  /** FULL stored content length (chars), so a caller can decide to fetch by id. */
  contentLength: number
  /** True when `content` is a cut of the stored text (marker appended). */
  truncated: boolean
}

/**
 * Bound `content` to {@link MAX_EXCERPT_LENGTH}. Short content passes through
 * verbatim; long content is cut to fit the cap WITH the {@link EXCERPT_MARKER}
 * appended (the marker rides inside the budget, so the result never exceeds the
 * schema bound). A trailing lone high surrogate at the cut point is dropped so
 * the excerpt is always well-formed UTF-16.
 */
export function excerptContent(content: string): ExcerptedContent {
  if (content.length <= MAX_EXCERPT_LENGTH) {
    return { content, contentLength: content.length, truncated: false }
  }
  let cut = content.slice(0, MAX_EXCERPT_LENGTH - EXCERPT_MARKER.length)
  const lastUnit = cut.charCodeAt(cut.length - 1)
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    cut = cut.slice(0, -1)
  }
  return { content: cut + EXCERPT_MARKER, contentLength: content.length, truncated: true }
}
