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
  type InlineFacets,
} from './environment.js'
export {
  dbForgettingRepo,
  type ForgettingCandidates,
  type ForgettingPassOptions,
  type ForgettingPassResult,
  type ForgettingRepo,
  type ForgettingStop,
  type ForgettingUsage,
  runForgettingPass,
} from './forgetting-pass.js'
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
  type ResolutionProposalRecord,
  rejectProposal,
  rejectProposalAnyKind,
  SuccessorNotLiveError,
} from './proposals.js'
export {
  type EdgeProposalsPage,
  listEdgeProposalsPage,
  listProposalsPage,
  type MergedPage,
  mergeProposalStreams,
  type ProposalPosition,
  type ProposalsPage,
  type ProposalsPageQuery,
} from './proposals-page.js'
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
  expiryCutoff,
  LEGACY_SURFACING_POLICY,
  type SurfacingPolicy,
  type SurfacingRepo,
  type SurfacingResult,
  surface,
} from './surfacing.js'
