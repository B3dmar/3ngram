// SPDX-License-Identifier: Apache-2.0
// Agent-session bookkeeping facade (docs/concepts/session-continuity.mdx).
export {
  AgentSessionNotFoundError,
  AgentSessionParamsConflictError,
  type AgentSessionRecord,
  type CloseSessionResult,
  closeAgentSession,
  getAgentSession,
  type HeartbeatSessionResult,
  heartbeatAgentSession,
  type OpenSessionResult,
  openAgentSession,
  type SessionClockOptions,
} from './lifecycle.js'
