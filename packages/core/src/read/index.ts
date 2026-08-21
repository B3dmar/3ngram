// SPDX-License-Identifier: Apache-2.0

// --- briefing/handoff orientation reads ---
export {
  type Briefing,
  type BriefingCommitment,
  type BriefingMemoryItem,
  type BriefingMode,
  type BriefingQuery,
  type BriefingSection,
  type BriefingSelector,
  briefing,
  DEFAULT_BRIEFING_TOP,
  EmptySectionsError,
  type FullBriefing,
  MAX_BRIEFING_SECTION,
  MissingSelectorError,
  requireSelector,
  STALE_CANDIDATE_TYPES,
  STALE_WINDOW_DAYS,
} from './briefing.js'
export {
  type ExportAccountRow,
  type ExportAgentSessionRow,
  type ExportBudgetRow,
  type ExportCommitmentRow,
  type ExportEdgeRow,
  type ExportEnricher,
  type ExportFactProposalRow,
  type ExportFactRow,
  type ExportLlmUsageRow,
  type ExportMemoryEventRow,
  type ExportMemoryRow,
  type ExportProposalRow,
  type ExportScopeRow,
  type ExportUserProfileRow,
  exportUserData,
  type UserDataExport,
} from './export.js'
export {
  type AsOf,
  type FactRow,
  type FactsQuery,
  getFacts,
} from './facts.js'
export {
  type Handoff,
  type HandoffCommitment,
  type HandoffMemory,
  type HandoffQuery,
  handoff,
  MAX_HANDOFF_SECTION,
} from './handoff.js'
// --- dashboard reads: bounded memory list + single-id inspect + /me ---
export {
  listMemories,
  listMemoryFacets,
  type MemoriesListQuery,
  type MemoriesPage,
  type MemoryFacets,
  type MemoryListRow,
} from './list-memories.js'
export { getCurrentUser, type UserIdentityRow } from './me.js'
export {
  type GetMemoriesOptions,
  getMemoriesByIds,
  getMemoryById,
  type MemoriesBatchRead,
  type MemoryBatchItem,
  type MemoryDetailRow,
  MemoryNotFoundError,
} from './memory.js'
export { getMemoryHistory, type MemoryHistoryRead } from './memory-history.js'
// --- retrieval-scope policy enforcement (issue #47) ---
export {
  applyPolicyToScopeFilter,
  applyPolicyToSelector,
  formatUnscopedRetrievalDetail,
  type RetrievalPolicy,
  UnscopedRetrievalError,
} from './retrieval-policy.js'
export {
  type DashboardPageOptions,
  type DashboardSearchPage,
  DEFAULT_SEARCH_SUPERSESSION_PENALTY,
  DEFAULT_SEARCH_WEIGHTS,
  type EmbeddingSource,
  type FrozenOrdering,
  type FusionWeights,
  InvalidEmbeddingError,
  type ScopedSearchResult,
  type SearchHit,
  type SearchOptions,
  search,
  searchDashboardPage,
} from './search.js'
export { type ListOptions, type ListPage, searchChronological } from './search-list.js'
