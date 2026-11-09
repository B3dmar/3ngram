// SPDX-License-Identifier: Apache-2.0
// getMemoryHistory(): content-free lineage/audit read for the memory detail page.
// Mirrors getMemoryById's not-found policy, but deliberately
// returns identity/audit metadata only — plus, as the one content field, the
// owner's `lastResolutionReason` for the memory's commitment (issue #234). Full
// memory content remains limited to the inspect endpoint/read.
import {
  type MemoryHistoryRead as DbMemoryHistoryRead,
  getMemoryHistory as getMemoryHistoryDb,
  withSavepoint,
  withTenant,
} from '@3ngram/db'
import type { MemoryProvenance } from '@3ngram/schema'
import { MemoryNotFoundError } from './memory.js'
import { getMemoriesProvenance } from './memory-provenance.js'

export type {
  MemoryHistoryEdgeRow,
  MemoryHistoryEventRow,
  MemoryHistoryIdentityRow,
  MemoryHistoryLifecycleState,
  MemoryHistoryPayloadMetadataRow,
  MemoryHistoryRelationshipRow,
  MemoryHistorySectionStatus,
  MemoryHistorySections,
} from '@3ngram/db'

export interface MemoryHistoryRead extends DbMemoryHistoryRead {
  provenance?: MemoryProvenance | null
  sections: DbMemoryHistoryRead['sections'] & { provenance?: 'ok' | 'unavailable' }
  sectionErrors?: DbMemoryHistoryRead['sectionErrors'] & { provenance?: string }
}

/**
 * Fetch the history/audit read model for one memory id. Throws
 * {@link MemoryNotFoundError} when the id is absent for the tenant (the only
 * hard-fail — it maps to 404). A readable identity always resolves, even when a
 * section degraded to `unavailable`; the per-section status rides on
 * `MemoryHistoryRead.sections` for the surface to render partial results. Runs
 * inside withTenant(userId), and the db read binds every statement to the same
 * userId: RLS plus an explicit predicate (two-layer isolation).
 */
export async function getMemoryHistory(
  userId: string,
  memoryId: string,
): Promise<MemoryHistoryRead> {
  return withTenant(
    userId,
    async (tx) => {
      const row = await getMemoryHistoryDb(tx, userId, memoryId)
      if (row === undefined) throw new MemoryNotFoundError(memoryId)
      try {
        const chains = await withSavepoint(tx, 'history_provenance', () =>
          getMemoriesProvenance(tx, userId, [row.memory.id]),
        )
        return {
          ...row,
          provenance: chains.get(row.memory.id) ?? null,
          sections: { ...row.sections, provenance: 'ok' },
        }
      } catch (error) {
        return {
          ...row,
          provenance: null,
          sections: { ...row.sections, provenance: 'unavailable' },
          sectionErrors: {
            ...row.sectionErrors,
            provenance: error instanceof Error ? error.name : 'Error',
          },
        }
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
