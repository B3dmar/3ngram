// SPDX-License-Identifier: Apache-2.0
// NOTE: biome organizeImports keeps these export statements sorted by source, so
// new symbols are merged into their source's block rather than appended as a
// trailing block (workstream F1+F2 added listTenantIds,
// sweepCommitments/SurfacingSweepResult, insertProposals/ProposalWrite,
// findSimilarPairs/SimilarPair/searchVector).

// --- account deletion PII erasure — RLS-scoped redact ---
export {
  type AccountErasureResult,
  deletedEmail,
  ERASED_PII,
  eraseAccountData,
} from './account-delete.js'
// --- audit log — system table, getAdminDb() path ---
export { type AuditLogEntry, auditLogEntryExists, insertAuditLog } from './audit-log.js'
export {
  DuplicateEmailError,
  getUserByEmail,
  getUserPasswordHashById,
  insertUnverifiedUserWithEmailVerificationToken,
  insertUser,
  listTenantIds,
  retryUnverifiedSignupWithEmailVerificationToken,
  type SignupEmailVerificationToken,
  type UserRow,
  updateUserPassword,
} from './auth-admin.js'
export {
  type ApiKeyMetadata,
  insertApiKey,
  listApiKeys,
  type ResolvedApiKey,
  resolveApiKey,
  revokeApiKey,
  touchApiKeyLastUsed,
} from './auth-api-keys.js'
export {
  insertEmailVerificationToken,
  type NewEmailVerificationToken,
  peekEmailVerificationToken,
  replaceEmailVerificationTokens,
  verifyEmailTokenAtomic,
} from './auth-email-verification.js'
// --- OAuth AS A1 (RFC 7591 DCR) — oauth_clients is a GLOBAL system
// table (no RLS); these helpers use the audited admin path per auth-admin.ts ---
export {
  type AuthorizedClient,
  deleteClients,
  getClientByClientId,
  listClientsAuthorizedByUser,
  listGarbageCollectableClients,
  materializeClientMetadata,
  type NewOAuthClient,
  type OAuthClientRow,
  registerClient,
  revokeClientForUser,
  updateLastUsedAt,
} from './auth-oauth-clients.js'
// --- OAuth AS A2 (authorize/token) — codes are tenant-scoped writes
// + the atomic SECURITY DEFINER consume path (single-use under concurrency) ---
export {
  type ConsumedOauthCode,
  consumeOauthCode,
  insertOauthCode,
  type NewOauthCode,
} from './auth-oauth-codes.js'
// --- auth (OAuth resource server) — appended block;
// issuance + one-time refresh rotation over the same table ---
export {
  insertOauthTokenPair,
  type NewOauthToken,
  type ResolvedOauthToken,
  resolveOauthToken,
  rotateOauthRefreshToken,
  userHasOauthToken,
} from './auth-oauth-tokens.js'
// --- forgotten-password reset — tenant-scoped mint + the atomic
// SECURITY DEFINER single-use consume path (mirrors auth-oauth-codes.ts) ---
export {
  consumePasswordResetToken,
  insertPasswordResetToken,
  type NewPasswordResetToken,
  peekResetToken,
  resetPasswordAtomic,
} from './auth-reset-tokens.js'
export {
  deleteOtherSessions,
  insertSession,
  type ResolvedSession,
  resolveSession,
  rotatePasswordAndRevokeOthers,
} from './auth-sessions.js'
// --- briefing/handoff orientation reads — appended block ---
export {
  activeBlockers,
  activePreferences,
  type BriefingCommitmentRow,
  type BriefingMemoryRow,
  type BriefingPage,
  type BriefingSelector,
  openCommitments,
  overdueCommitments,
  recentDecisions,
  staleCandidates,
} from './briefing-read.js'
// --- budget accounting read + operator override write ---
export {
  type BudgetAccounting,
  type BudgetReservation,
  getBudgetAccounting,
  getUserBudget,
  releaseReservation,
  reserveBudget,
  setBudgetWindow,
  setBudgetWindowInTx,
  setUserBudget,
  type UserBudgetRow,
  type UserBudgetWrite,
} from './budget-read.js'
// getAdminDb stays internal: the unscoped pre-tenant handle must not leak
// through the public barrel — consumers get the narrow typed helpers
// (auth-admin.ts) only, so the db-access discipline stays auditable.
export { closeDb, type TenantTx, withTenant } from './client.js'
// --- Commitments FSM + embed-on-write (slice 3) — appended block ---
export {
  type CommitmentCreate,
  CommitmentExistsError,
  CommitmentNotFoundError,
  type CommitmentState,
  type CommitmentTransition,
  createCommitment,
  getCommitment,
  getCommitmentByMemoryId,
  IllegalCommitmentTransitionError,
  NotCommitmentMemoryError,
  type SurfacingSweepResult,
  sweepCommitments,
  transitionCommitment,
  type WrittenCommitment,
} from './commitments.js'
// --- credential-resurrection guard ---
export { AccountDeletedError } from './credential-guard.js'
// --- full-account data export (GDPR portability) — appended block ---
export {
  type ExportAccountRow,
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
  type ExportRetrievalPolicyRow,
  type ExportScopeRow,
  type ExportUserProfileRow,
  readUserDataExport,
  type UserDataExport,
} from './data-export.js'
export {
  FACT_PROPOSAL_COLUMNS,
  type FactProposalRow,
  type FactProposalsQuery,
  type FactProposalWrite,
  insertFactProposals,
  listFactProposals,
  rejectFactProposal,
} from './fact-proposals.js'
// --- fact proposals: staged extraction awaiting human review ---
export {
  type AppliedFactProposal,
  applyFactProposal,
} from './fact-proposals-apply.js'
// --- bi-temporal facts read (slice 2) — appended as its own block ---
export {
  type AsOf,
  type FactRow,
  type FactsQuery,
  getFacts,
  transactionTimePredicate,
  validTimePredicate,
} from './facts-read.js'
// --- facts write path: tx-taking inserts composed by the memory write ---
export {
  type FactWrite,
  insertFact,
  insertFacts,
  type MemoryFactWrite,
} from './facts-write.js'
// --- llm_usage cost tracking — RLS-scoped, withTenant() ---
export { insertLlmUsage, type LlmUsageWrite } from './llm-usage.js'
// Revise path + typed edges (slice 2) — appended as its own block.
export { EdgeConflictError, type EdgeWrite, insertEdge } from './memory-edges.js'
export {
  type EmbedFailedMemoryRow,
  listEmbedFailedMemories,
  recordEmbedFailure,
  updateMemoryEmbedding,
} from './memory-embedding.js'
export {
  getMemoryHistory,
  MEMORY_HISTORY_DIRECT_RELATIONSHIP_LIMIT,
  MEMORY_HISTORY_EVENT_LIMIT,
  MEMORY_HISTORY_LINEAGE_EDGE_LIMIT,
  MEMORY_HISTORY_LINEAGE_NODE_LIMIT,
  type MemoryHistoryEdgeRow,
  type MemoryHistoryEventRow,
  type MemoryHistoryIdentityRow,
  type MemoryHistoryLifecycleState,
  type MemoryHistoryPayloadMetadataRow,
  type MemoryHistoryRead,
  type MemoryHistoryRelationshipRow,
  type MemoryHistorySectionStatus,
  type MemoryHistorySections,
} from './memory-history-read.js'
// --- import writes (groundwork for batch importers) — appended block ---
export {
  appendImportedEvent,
  type ImportedEdgeWrite,
  type ImportedEventWrite,
  type ImportedFactWrite,
  type ImportedMemoryWrite,
  ImportTargetNotFoundError,
  insertImportedFact,
  writeImportedEdge,
  writeImportedMemory,
} from './memory-import.js'
// --- dashboard memory reads: bounded list + single-id inspect ---
export {
  countMemories,
  getMemoriesByIds,
  getMemoryById,
  listMemories,
  listMemoryFacets,
  type MemoriesListQuery,
  type MemoryDetailRow,
  type MemoryFacets,
  type MemoryListRow,
} from './memory-read.js'
export {
  ActiveMemoryNotFoundError,
  archiveBlockerMemory,
  archiveMemory,
  BlockerNotFoundError,
  PredecessorAlreadySupersededError,
  PredecessorNotFoundError,
  type ReviseWrite,
  reviseMemory,
} from './memory-revise.js'
export {
  DuplicateMemoryError,
  insertMemoryWithEvent,
  type MemoryEventWrite,
  type MemoryWrite,
  type WrittenMemory,
  writeMemory,
} from './memory-write.js'
// --- review_proposals ACCEPT/apply — appended block ---
export {
  type AppliedProposalRow,
  applyProposal,
  EpisodicSupersessionError,
  SuccessorNotLiveError,
} from './proposals-apply.js'
// --- MCP admin tools D3: scopes registry + proposals + env stats ---
export {
  countProposalsByStatus,
  listProposals,
  ProposalNotFoundError,
  type ProposalRow,
  type ProposalsQuery,
  rejectProposal,
} from './proposals-read.js'
export { insertProposals, type ProposalWrite } from './proposals-write.js'
export { ResourceLimitExceededError } from './resource-limits.js'
// --- retrieval-scope policy store (issue #47) ---
export {
  getRetrievalPolicy,
  lockRetrievalScopePolicy,
  type RetrievalPolicyRow,
  replaceRetrievalPolicyDefault,
  upsertRetrievalPolicy,
} from './retrieval-policy.js'
// --- runtime fail-closed RLS guard (readiness/boot verification) ---
export {
  assertRlsInForce,
  DEFAULT_RUNTIME_ROLE,
  RlsGuardError,
  type RlsGuardOptions,
  readForcedTenantTables,
} from './rls-guard.js'
export * from './schema/agent-sessions.js'
export * from './schema/budget.js'
export * from './schema/identity.js'
export * from './schema/memory.js'
export * from './schema/ops.js'
export {
  createScope,
  deleteScope,
  type EnvironmentStats,
  getEnvironmentStats,
  listScopes,
  renameScope,
  ScopeNameConflictError,
  ScopeNotFoundError,
  type ScopeRow,
  setScopeAliases,
} from './scopes.js'
export {
  CANDIDATE_POOL_FLOOR,
  DEFAULT_FUSION_WEIGHTS,
  DEFAULT_RECENCY_HALF_LIFE_DAYS,
  DEFAULT_SUPERSESSION_PENALTY,
  EMBEDDING_DIMENSIONS,
  type FusionWeights,
  fetchHitsByIds,
  findSimilarPairs,
  InvalidEmbeddingError,
  type SearchAsOf,
  type SearchFilters,
  type SearchHit,
  type SimilarPair,
  searchFts,
  searchFused,
  searchRecency,
  searchVector,
} from './search.js'
export {
  type ChronologicalCursor,
  type ChronologicalPage,
  searchList,
} from './search-list.js'
export {
  getUserProfileAttributes,
  upsertUserProfileAttributes,
} from './user-profile-attributes.js'
// --- /me identity read: keyed id+email lookup, no credential ---
export { getUserIdentityById, type UserIdentityRow } from './users-read.js'
