// SPDX-License-Identifier: Apache-2.0
// Explicit null must never borrow another conversation's provenance or re-arm it.
import { closeDb } from '@3ngram/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { archiveMemory } from '../../src/write/archive.js'
import { resolveByMemoryId } from '../../src/write/commitments.js'
import { remember } from '../../src/write/remember.js'
import { revise } from '../../src/write/revise.js'
import { reviseDisposition } from '../../src/write/revise-disposition.js'

const RUN = '01890b6e-0000-7000-8000-0000000000aa'
const ACTOR = 'user_mcp'
const PROJECT = 'attribution-test'
const CASES = [
  'remember',
  'revise',
  'move',
  'archive',
  'reaffirm',
  'resolve',
  'blocker',
  'rest-archive',
] as const
type WriteCase = (typeof CASES)[number]
const EXPECTED_EVENT: Record<WriteCase, string> = {
  remember: 'create',
  revise: 'supersede',
  move: 'revise',
  archive: 'archive',
  reaffirm: 'reaffirm',
  resolve: 'resolve',
  blocker: 'archive',
  'rest-archive': 'archive',
}
let user: string

beforeAll(async () => {
  user = await seedUser('unattributed@test.local')
})
beforeEach(async () => {
  await resetDomainTables()
  await ownerPool.query(
    `INSERT INTO agent_sessions
      (id, user_id, agent, session_id, source, project, selector, last_seen_at, triage_status, needs_look)
     VALUES ($1, $2, 'codex', 'unrelated-conversation', 'startup', $3, '{"kind":"all"}',
       now() - interval '1 minute', 'completed', false)`,
    [RUN, user, PROJECT],
  )
})
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

async function writeWithoutAttribution(kind: WriteCase, id: string): Promise<void> {
  if (kind === 'revise') {
    await revise(
      user,
      {
        predecessorId: id,
        memoryType: 'decision',
        topic: 'revised',
        content: 'successor',
        sessionRunId: null,
      },
      ACTOR,
    )
  } else if (kind === 'move') {
    const input = { kind: 'move', predecessorId: id, tags: ['refiled'], sessionRunId: null }
    await revise(user, input, ACTOR)
    await revise(user, input, ACTOR) // No-op still must accept null.
  } else if (kind === 'archive' || kind === 'reaffirm') {
    const input = { kind, memoryIds: [id], sessionRunId: null }
    await reviseDisposition(user, input, ACTOR)
    if (kind === 'archive') await reviseDisposition(user, input, ACTOR)
  } else if (kind === 'resolve' || kind === 'blocker') {
    await resolveByMemoryId(user, id, 'resolved', ACTOR, null)
    if (kind === 'resolve') await resolveByMemoryId(user, id, 'resolved', ACTOR, null)
  } else if (kind === 'rest-archive') {
    await archiveMemory(user, id, ACTOR, null)
  }
}

describe('native writes with sessionRunId: null', () => {
  it.each(CASES)('%s leaves the sole unrelated open session completely unchanged', async (kind) => {
    const before = await ownerPool.query('SELECT * FROM agent_sessions WHERE id = $1', [RUN])
    const memoryType =
      kind === 'resolve' ? 'commitment' : kind === 'blocker' ? 'blocker' : 'decision'
    const { id } = await remember(
      user,
      {
        memoryType,
        topic: 'independent conversation',
        content: 'original',
        scope: 'work',
        project: PROJECT,
        sessionRunId: null,
      },
      ACTOR,
    )
    await writeWithoutAttribution(kind, id)

    const after = await ownerPool.query('SELECT * FROM agent_sessions WHERE id = $1', [RUN])
    expect(after.rows).toEqual(before.rows)
    const events = await ownerPool.query(
      'SELECT event_kind, payload FROM memory_events WHERE user_id = $1',
      [user],
    )
    expect(events.rows.map((row) => row.event_kind)).toContain(EXPECTED_EVENT[kind])
    for (const event of events.rows) expect(event.payload?.sessionRunId).toBeUndefined()
  })
})
