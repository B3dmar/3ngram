// SPDX-License-Identifier: Apache-2.0
// Agent-session bookkeeping facade (docs/concepts/session-continuity.mdx).
export {
  AccountDeletedError,
  AgentSessionNotFoundError,
  AgentSessionParamsConflictError,
  type AgentSessionRecord,
  type AgentSessionRunRead,
  type CloseSessionResult,
  closeAgentSession,
  getAgentSession,
  getAgentSessionRun,
  getSessionTriageAttempts,
  type HeartbeatSessionResult,
  heartbeatAgentSession,
  type OpenSessionResult,
  openAgentSession,
  type SessionClockOptions,
  type SessionTriageAttempts,
} from './lifecycle.js'
export {
  AgentSessionTriageConflictError,
  type BeginTriageFacadeOptions,
  type BeginTriageOptions,
  type BeginTriageResult,
  beginAgentSessionTriage,
  type CompleteTriageResult,
  completeAgentSessionTriage,
  evaluateTriageEntry,
  type TriageDebounceThresholds,
  type TriageEntryDecision,
} from './triage.js'
