// SPDX-License-Identifier: Apache-2.0
// Search result shaping shared by ordinary and frozen-page reads. Excerpting
// belongs in core so every transport receives the same bounded content shape.
import type { SearchHit as DbSearchHit } from '@3ngram/db'
import { excerptContent } from './excerpt.js'

/** A fused hit whose content is bounded to the public read excerpt. */
export interface SearchHit extends DbSearchHit {
  /** Full stored content length in characters. */
  contentLength: number
  /** True when `content` was shortened to the public excerpt bound. */
  truncated: boolean
}

/** Policy-aware search envelope with the scope applied by a default policy. */
export interface ScopedSearchResult {
  hits: SearchHit[]
  appliedScope: string | null
}

/** Bound a stored hit to the public search-result content shape. */
export function shapeSearchHit(hit: DbSearchHit): SearchHit {
  return { ...hit, ...excerptContent(hit.content) }
}

/** Shape hits and preserve the legacy array/envelope overload contract. */
export function shapeSearchResult(
  hits: DbSearchHit[],
  appliedScope: string | null,
  policyAware: boolean,
): SearchHit[] | ScopedSearchResult {
  const shaped = hits.map(shapeSearchHit)
  return policyAware ? { hits: shaped, appliedScope } : shaped
}
