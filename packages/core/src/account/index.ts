// SPDX-License-Identifier: Apache-2.0
// Account-lifecycle barrel. Apache: deletion erases PII and
// physically deletes no memory-domain row; any platform cleanup rides the
// optional onAccountDeletion hook (no private import).
export {
  type AccountDeletionResult,
  type AccountErasureResult,
  type DeleteAccountOptions,
  deleteAccount,
} from './delete-account.js'
