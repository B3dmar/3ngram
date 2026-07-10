// SPDX-License-Identifier: Apache-2.0
// Budget barrel. Apache, license-safe: the access gate PORT + allow-all default
// and the per-user budget gate. Provider-agnostic — a real access/limits policy is
// injected from the private repo at the composition root.
export { AccessDeniedError, type AccessGate, allowAllAccess } from './access.js'
export {
  assertWithinBudget,
  type BudgetConfig,
  type BudgetEnforcement,
  BudgetExceededError,
  type BudgetLogger,
  type BudgetReservationHandle,
  type BudgetStatus,
  getBudgetStatus,
  type Limits,
  type LimitsResolver,
  releaseBudgetReservation,
  reserveBudgetSlot,
  SELFHOST_LIMITS,
} from './budget.js'
export { resolveResourceLimits } from './resource-limits.js'
