// SPDX-License-Identifier: Apache-2.0
// Thin REST search transports. Authentication is mounted by restRouter before
// this child router; policy resolution and search behavior remain in core.
import {
  type AccessGate,
  applyPolicyToScopeFilter,
  type BudgetEnforcement,
  type DashboardSearchPage,
  resolveRetrievalPolicy,
  type ScopedSearchResult,
  search,
  searchDashboardPage,
} from '@3ngram/core'
import type { Gateway } from '@3ngram/llm'
import {
  type DashboardSearchQuery,
  dashboardSearchQuerySchema,
  type SearchQueryInput,
  searchQuerySchema,
} from '@3ngram/schema'
import { type Request, type Response, Router } from 'express'
import { decodeSearchCursor, encodeCursor, searchFingerprint } from '../cursor.js'
import { defined, guard, tenant, toAsOf } from './route-helpers.js'

export interface SearchRouterOptions {
  gateway: Gateway | undefined
  budget?: BudgetEnforcement | undefined
  access?: AccessGate | undefined
}

function searchFilters(input: SearchQueryInput | DashboardSearchQuery) {
  return defined({
    memoryType: input.memoryType,
    scope: input.scope,
    project: input.project,
    status: input.status,
    asOf: toAsOf(input.asOf),
  })
}

function publicResponse(result: ScopedSearchResult) {
  return {
    hits: result.hits.map((hit) => ({
      id: hit.id,
      memoryType: hit.memoryType,
      topic: hit.topic,
      content: hit.content,
      contentLength: hit.contentLength,
      truncated: hit.truncated,
      score: hit.score,
    })),
    count: result.hits.length,
    ...(result.appliedScope === null ? {} : { appliedScope: result.appliedScope }),
  }
}

async function handlePublicSearch(
  req: Request,
  res: Response,
  options: SearchRouterOptions,
): Promise<void> {
  if (options.gateway === undefined) {
    res.status(503).json({ error: 'embedding_unavailable' })
    return
  }
  const input = searchQuerySchema.parse(req.body)
  const userId = tenant(req)
  if (options.access) await options.access.assertRead(userId)
  const retrievalPolicy = await resolveRetrievalPolicy(userId)
  const result = await search(
    userId,
    input.query,
    { gateway: options.gateway },
    { limit: input.limit, filters: searchFilters(input), budget: options.budget, retrievalPolicy },
  )
  res.status(200).json(publicResponse(result))
}

function frozenPage(input: DashboardSearchQuery, fingerprint: string) {
  if (input.cursor === undefined) return undefined
  const decoded = decodeSearchCursor(input.cursor, fingerprint)
  return decoded === undefined
    ? undefined
    : {
        ids: decoded.ids,
        scores: decoded.scores,
        off: decoded.off,
        ...(decoded.policyScope === undefined ? {} : { policyScope: decoded.policyScope }),
      }
}

function nextCursor(page: DashboardSearchPage, fingerprint: string): string | undefined {
  if (!page.hasMore) return undefined
  return encodeCursor({
    v: 2,
    ids: page.frozen.ids,
    scores: page.frozen.scores,
    off: page.nextOffset,
    fp: fingerprint,
    policyScope: page.frozen.policyScope,
  })
}

function dashboardResponse(page: DashboardSearchPage, cursor: string | undefined) {
  return {
    hits: page.hits.map((hit) => ({
      id: hit.id,
      memoryType: hit.memoryType,
      topic: hit.topic,
      score: hit.score,
      ...(hit.commitmentStatus == null ? {} : { commitmentStatus: hit.commitmentStatus }),
    })),
    count: page.hits.length,
    hasMore: page.hasMore,
    ...(cursor === undefined ? {} : { nextCursor: cursor }),
    ...(page.appliedScope == null ? {} : { appliedScope: page.appliedScope }),
  }
}

async function handleDashboardSearch(
  req: Request,
  res: Response,
  options: SearchRouterOptions,
): Promise<void> {
  if (options.gateway === undefined) {
    res.status(503).json({ error: 'embedding_unavailable' })
    return
  }
  const input = dashboardSearchQuerySchema.parse(req.body)
  const filters = searchFilters(input)
  const userId = tenant(req)
  if (options.access) await options.access.assertRead(userId)
  const retrievalPolicy = await resolveRetrievalPolicy(userId)
  const policyScope = applyPolicyToScopeFilter(retrievalPolicy, filters.scope)
  const fingerprint = searchFingerprint(input.query, filters, policyScope.scope)
  const page = await searchDashboardPage(
    userId,
    input.query,
    { gateway: options.gateway },
    defined({
      limit: input.limit,
      filters,
      frozen: frozenPage(input, fingerprint),
      budget: options.budget,
      retrievalPolicy,
    }),
  )
  res.status(200).json(dashboardResponse(page, nextCursor(page, fingerprint)))
}

export function searchRouter(options: SearchRouterOptions): Router {
  const router = Router()
  router.post('/api/v1/search', (req, res) => {
    void guard('search', res, () => handlePublicSearch(req, res, options))
  })
  router.post('/api/v1/dashboard/search', (req, res) => {
    void guard('dashboard.search', res, () => handleDashboardSearch(req, res, options))
  })
  return router
}
