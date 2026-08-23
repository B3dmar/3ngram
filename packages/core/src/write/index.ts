// SPDX-License-Identifier: Apache-2.0
export { archiveMemory } from './archive.js'
export {
  BlockerNotFoundError,
  type ClosedRunResolveOutcome,
  CommitmentExistsError,
  CommitmentNotFoundError,
  CommitmentStateChangedError,
  type CreateCommitmentOptions,
  createCommitment,
  IllegalCommitmentTransitionError,
  InvalidCommitmentTransitionError,
  NotCommitmentMemoryError,
  type ResolveStatus,
  resolveByMemoryId,
  // `resolveForClosedRun` is deliberately NOT re-exported — see its doc comment.
  // The session closer reaches it by deep import; nothing else may.
  transition,
  type WrittenCommitment,
} from './commitments.js'
export {
  EMPTY_EMBED_INPUT_REASON,
  type EmbedLogger,
  type EmbedOptions,
  kickEmbed,
} from './embed.js'
export {
  DuplicateMemoryError,
  remember,
  UnknownSessionRunError,
  type WriteResult,
  type WrittenMemory,
} from './remember.js'
export {
  type RetryFailedEmbedsOptions,
  type RetryFailedEmbedsResult,
  retryFailedEmbeds,
} from './repair.js'
export {
  EdgeConflictError,
  PredecessorAlreadySupersededError,
  PredecessorNotFoundError,
  revise,
} from './revise.js'
