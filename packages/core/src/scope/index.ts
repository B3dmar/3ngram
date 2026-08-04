// SPDX-License-Identifier: Apache-2.0
export {
  type RetrievalPolicySetting,
  resolveRetrievalPolicy,
  setRetrievalDefault,
} from './retrieval-settings.js'
export {
  createScope,
  deleteScope,
  listScopes,
  renameScope,
  ScopeNameConflictError,
  ScopeNotFoundError,
  type ScopeRecord,
  setScopeAliases,
} from './scopes.js'
