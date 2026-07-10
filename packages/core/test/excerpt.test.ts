// SPDX-License-Identifier: Apache-2.0
// Unit — the read-path content excerpting policy. Pure function,
// no DB: the cap and marker are FROZEN at the one validation boundary
// (packages/schema); this suite pins that the policy always produces a value
// the output schemas accept, never mutating stored content (read-side only).
import { EXCERPT_MARKER, MAX_EXCERPT_LENGTH } from '@3ngram/schema'
import { describe, expect, it } from 'vitest'
import { excerptContent } from '../src/read/excerpt.js'

describe('excerptContent — read-path bound (issue #238)', () => {
  it('passes short content through verbatim with truncated=false', () => {
    const result = excerptContent('a short memory')
    expect(result).toEqual({
      content: 'a short memory',
      contentLength: 'a short memory'.length,
      truncated: false,
    })
  })

  it('passes content at EXACTLY the cap through unmarked', () => {
    const content = 'a'.repeat(MAX_EXCERPT_LENGTH)
    const result = excerptContent(content)
    expect(result.content).toBe(content)
    expect(result.truncated).toBe(false)
  })

  it('cuts one-over-the-cap content to the cap WITH the marker inside the budget', () => {
    const result = excerptContent('b'.repeat(MAX_EXCERPT_LENGTH + 1))
    expect(result.content.length).toBe(MAX_EXCERPT_LENGTH)
    expect(result.content.endsWith(EXCERPT_MARKER)).toBe(true)
    expect(result.contentLength).toBe(MAX_EXCERPT_LENGTH + 1)
    expect(result.truncated).toBe(true)
  })

  it('reports the FULL stored length for an import-scale row (max seen ~245K)', () => {
    const result = excerptContent('c'.repeat(245_428))
    expect(result.content.length).toBe(MAX_EXCERPT_LENGTH)
    expect(result.contentLength).toBe(245_428)
    expect(result.truncated).toBe(true)
  })

  it('never splits a surrogate pair at the cut point (well-formed UTF-16)', () => {
    // Position an astral-plane char (2 UTF-16 units) so the cut would land
    // between its surrogates; the excerpt must drop the lone high surrogate.
    const cutPoint = MAX_EXCERPT_LENGTH - EXCERPT_MARKER.length
    const content = `${'d'.repeat(cutPoint - 1)}\u{1F600}${'e'.repeat(MAX_EXCERPT_LENGTH)}`
    const result = excerptContent(content)
    expect(result.truncated).toBe(true)
    expect(result.content.length).toBeLessThanOrEqual(MAX_EXCERPT_LENGTH)
    // A well-formed string round-trips through the UTF-8 encoder losslessly.
    const roundTrip = new TextDecoder().decode(new TextEncoder().encode(result.content))
    expect(roundTrip).toBe(result.content)
  })
})
