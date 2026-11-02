// SPDX-License-Identifier: Apache-2.0
import { and, count, eq, isNull, ne, notExists, or } from 'drizzle-orm'
import { withTenant } from './client.js'
import { memories, memoryEvents } from './schema/memory.js'

/** Live memory count excluding only the system-created seed identified by core. */
export async function countUserMemories(userId: string, seedContentHash: string): Promise<number> {
  return withTenant(userId, async (tx) => {
    const systemCreated = tx
      .select({ id: memoryEvents.id })
      .from(memoryEvents)
      .where(
        and(
          eq(memoryEvents.userId, userId),
          eq(memoryEvents.memoryId, memories.id),
          eq(memoryEvents.eventKind, 'create'),
          eq(memoryEvents.actorKind, 'system'),
        ),
      )
    const [row] = await tx
      .select({ total: count() })
      .from(memories)
      .where(
        and(
          eq(memories.userId, userId),
          eq(memories.status, 'active'),
          isNull(memories.validTo),
          or(ne(memories.contentHash, seedContentHash), notExists(systemCreated)),
        ),
      )
    return row?.total ?? 0
  })
}
