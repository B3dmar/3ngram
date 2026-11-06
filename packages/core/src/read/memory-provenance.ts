// SPDX-License-Identifier: Apache-2.0
import { getMemoriesProvenance as read, type TenantTx } from '@3ngram/db'

/** Shared provenance policy for keyed reads and REST history; no transport builds a chain. */
export function getMemoriesProvenance(tx: TenantTx, userId: string, memoryIds: string[]) {
  return read(tx, userId, memoryIds)
}
