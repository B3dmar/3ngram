// SPDX-License-Identifier: Apache-2.0
// consolidate.js + surfacing.js exports; biome organizeImports keeps these
// export statements sorted by source.
export {
  type ConsolidateOptions,
  type ConsolidateRepo,
  type ConsolidateResult,
  chooseProposedEdge,
  consolidate,
  DEFAULT_CONSOLIDATION_LIMIT,
  DEFAULT_CONSOLIDATION_SIMILARITY,
  dbConsolidateRepo,
} from './consolidate.js'
export {
  describeEnvironment,
  type EnvironmentReport,
  type EnvironmentStats,
} from './environment.js'
export {
  dbGcClientsRepo,
  GC_CLIENT_IDLE_DAYS,
  type GcClientsOptions,
  type GcClientsRepo,
  type GcClientsResult,
  garbageCollectClients,
} from './gc-clients.js'
export {
  type AllProposals,
  type AppliedProposalRow,
  acceptProposalAnyKind,
  applyProposal,
  type DecidedProposal,
  EpisodicSupersessionError,
  type FactProposalRecord,
  listAllProposals,
  listProposals,
  ProposalNotFoundError,
  type ProposalRecord,
  type ProposalsListQuery,
  rejectProposal,
  rejectProposalAnyKind,
  SuccessorNotLiveError,
} from './proposals.js'
export {
  CLOSER_ACTOR_KIND,
  CLOSER_EVENTS_PAGE_SIZE,
  CLOSER_MAX_OUTPUT_TOKENS,
  CLOSER_OPERATION,
  type CloserClaim,
  type CloserEventPage,
  type CloserEventSummary,
  type CloserFinish,
  type CloserOptions,
  type CloserResult,
  type CloserSessionInput,
  type CloserSkipReason,
  type CloserUsage,
  CloserVerdictError,
  COMPLETION_PRICE_USD_PER_TOKEN,
  closeSessionRun,
  completionCostUsd,
  dbSessionCloserRepo,
  isCloserEligible,
  renderCloserPrompt,
  type SessionCloserRepo,
  selectResolvable,
} from './session-closer.js'
export {
  type CloserEnqueueRequest,
  dbSessionSweepRepo,
  type SessionSweepOptions,
  type SessionSweepRepo,
  type SessionSweepResult,
  sweepSessions,
} from './session-sweep.js'
export {
  dbSurfacingRepo,
  type SurfacingRepo,
  type SurfacingResult,
  surface,
} from './surfacing.js'
