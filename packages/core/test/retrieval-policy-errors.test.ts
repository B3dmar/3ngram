// SPDX-License-Identifier: Apache-2.0
import { MAX_REST_ERROR_DETAIL_LENGTH } from '@3ngram/schema'
import { describe, expect, it } from 'vitest'
import {
  formatUnscopedRetrievalDetail,
  UnscopedRetrievalError,
} from '../src/read/retrieval-policy.js'

describe('retrieval-policy recovery detail', () => {
  it('preserves the actionable detail for a small registry', () => {
    expect(formatUnscopedRetrievalDetail(['personal', 'work'])).toBe(
      "this account requires an explicit retrieval scope (retrieval-scope mode 'require') — registered scopes: personal, work",
    )
  })

  it('bounds large registries and reports omitted scopes', () => {
    const registeredScopes = Array.from({ length: 100 }, (_, index) => `scope-${index}`)
    const error = new UnscopedRetrievalError(registeredScopes)

    expect(error.registeredScopes).toHaveLength(100)
    expect(error.message.length).toBeLessThanOrEqual(MAX_REST_ERROR_DETAIL_LENGTH)
    expect(error.message).toContain('scope-0, scope-1')
    expect(error.message).toContain('+92 more omitted')
  })

  it('omits an individual name that cannot fit in the response budget', () => {
    const detail = formatUnscopedRetrievalDetail(['x'.repeat(1_000)])

    expect(detail.length).toBeLessThanOrEqual(MAX_REST_ERROR_DETAIL_LENGTH)
    expect(detail).toContain('+1 omitted')
  })
})
