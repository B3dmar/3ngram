// SPDX-License-Identifier: Apache-2.0
// Mandatory suite 3 (docs/concepts/testing.mdx): append-only is a GRANT, not a convention.
import { afterAll, describe, expect, it } from 'vitest'
import { closePools, withTestTransaction } from './helpers.js'

afterAll(closePools)

describe('append-only enforcement (runtime role)', () => {
  for (const table of ['memory_events', 'audit_log']) {
    it(`${table}: UPDATE is permission-denied`, async () => {
      await withTestTransaction(async (c) => {
        await expect(c.query(`UPDATE ${table} SET created_at = now()`)).rejects.toThrow(
          /permission denied/,
        )
      })
    })
    it(`${table}: DELETE is permission-denied`, async () => {
      await withTestTransaction(async (c) => {
        await expect(c.query(`DELETE FROM ${table}`)).rejects.toThrow(/permission denied/)
      })
    })
  }

  // one transaction per table: a denied statement aborts its transaction,
  // so multiple assertions can't share one
  for (const t of ['memories', 'memory_edges', 'commitments', 'facts', 'consolidation_proposals']) {
    it(`${t}: DELETE is permission-denied (append-and-supersede)`, async () => {
      await withTestTransaction(async (c) => {
        await expect(c.query(`DELETE FROM ${t}`)).rejects.toThrow(/permission denied/)
      })
    })
  }
})
