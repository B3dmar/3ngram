// SPDX-License-Identifier: Apache-2.0
// Pins the SQL shape of the get_memories batch read (issue #240): the successor
// lookup is ONE lateral join served by memory_edges_target_idx, correlated on
// both user_id and id, never a correlated subselect per column.
import { drizzle } from 'drizzle-orm/node-postgres'
import { describe, expect, it } from 'vitest'
import type { TenantTx } from '../src/client.js'
import { getMemoriesByIdsQuery } from '../src/memory-read.js'

const USER = '00000000-0000-7000-8000-000000000001'
const ID = '00000000-0000-7000-8000-0000000000aa'

describe('getMemoriesByIds query shape', () => {
  it('resolves the successor with one lateral join bound to the tenant and the row', () => {
    const db = drizzle.mock()
    const { sql } = getMemoriesByIdsQuery(db as unknown as TenantTx, USER, [ID]).toSQL()
    const lower = sql.toLowerCase()
    expect((lower.match(/left join lateral/g) ?? []).length).toBe(1)
    expect(lower).not.toContain('(select e.')
    expect(lower).toContain('"memory_edges"."user_id" = "memories"."user_id"')
    expect(lower).toContain('"memory_edges"."to_id" = "memories"."id"')
    expect(lower).toContain('limit')
  })
})
