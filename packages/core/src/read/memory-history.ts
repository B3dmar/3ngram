// SPDX-License-Identifier: Apache-2.0
// getMemoryHistory(): content-free lineage/audit read for the memory detail page.
// Mirrors getMemoryById's not-found policy, but deliberately
// returns identity/audit metadata only. Full content remains limited to the
// inspect endpoint/read.
import {
  getMemoryHistory as getMemoryHistoryDb,
  type MemoryHistoryRead,
  withTenant,
} from '@3ngram/db'
import { MemoryNotFoundError } from './memory.js'

export type {
  MemoryHistoryEdgeRow,
  MemoryHistoryEventRow,
  MemoryHistoryIdentityRow,
  MemoryHistoryLifecycleState,
  MemoryHistoryPayloadMetadataRow,
  MemoryHistoryRead,
  MemoryHistoryRelationshipRow,
  MemoryHistorySectionStatus,
  MemoryHistorySections,
} from '@3ngram/db'

/**
 * Fetch the history/audit read model for one memory id. Throws
 * {@link MemoryNotFoundError} when the id is absent for the tenant (the only
 * hard-fail — it maps to 404). A readable identity always resolves, even when a
 * section degraded to `unavailable`; the per-section status rides on
 * `MemoryHistoryRead.sections` for the surface to render partial results. Runs
 * inside withTenant(): RLS enforces tenant isolation.
 */
export async function getMemoryHistory(
  userId: string,
  memoryId: string,
): Promise<MemoryHistoryRead> {
  const row = await withTenant(userId, (tx) => getMemoryHistoryDb(tx, memoryId))
  if (row === undefined) throw new MemoryNotFoundError(memoryId)
  return row
}
