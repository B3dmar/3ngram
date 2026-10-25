// SPDX-License-Identifier: Apache-2.0
// Integration — the full remember() -> briefing() -> resolve() loop against the
// real runtime role (app_user, NOBYPASSRLS) on the CI ephemeral Neon branch.
// Regression: a commitment/blocker written via remember() must be
// VISIBLE to a project-scoped briefing and (for a commitment) RESOLVABLE.
//
// ROOT CAUSE: the write path was never the defect. writeMemory()
// auto-creates the `open` commitments row for a commitment-type memory,
// and resolveByMemoryId() keys on the memory id (project-agnostic),
// so resolve always worked. The dogfood symptom — a remembered commitment/blocker
// missing from a PROJECT briefing — was project-scoping: a memory remembered
// WITHOUT an explicit project lands with project = NULL, and the briefing's
// project predicate filters with `memories.project = $project` (briefing-read.ts
// memoryScopePredicate), which a NULL-project row never matches. The conservative
// fix is to thread the caller's project through (the code already does); these
// tests pin the loop so a regression — a dropped project, a missing FSM row, a
// project-blind briefing predicate, or an unresolvable commitment — fails CI.
//
// Reuses packages/db integration infra (helpers.ts); mirrors the
// runtime-role discipline of remember.int.test.ts and briefing-read.int.test.ts.

import { closeDb } from '@3ngram/db'
import type { ActorKind } from '@3ngram/schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  closePools,
  ownerPool,
  resetDomainTables,
  seedUser,
} from '../../../db/test/integration/helpers.js'
import { dbSurfacingRepo, type SurfacingRepo, surface } from '../../src/admin/surfacing.js'
import { briefing } from '../../src/read/briefing.js'
import { resolveByMemoryId } from '../../src/write/commitments.js'
import { remember } from '../../src/write/remember.js'
import { revise } from '../../src/write/revise.js'

let userA: string

const ACTOR: ActorKind = 'user_mcp'
const NOW = new Date('2026-06-13T12:00:00.000Z')
const PROJECT = '3ngram'

beforeAll(async () => {
  userA = await seedUser('rbr-loop-a@test.local')
})
beforeEach(resetDomainTables)
afterAll(async () => {
  await resetDomainTables()
  await closeDb()
  await closePools()
})

describe('remember -> briefing -> resolve loop, project-scoped (issue #244)', () => {
  it('a project commitment is auto-created, surfaces in the project briefing, and resolves', async () => {
    const { id, commitmentId } = await remember(
      userA,
      {
        memoryType: 'commitment',
        topic: 'Next pickup: docs site',
        content: 'pick the docs-site work back up next session',
        project: PROJECT,
      },
      ACTOR,
    )

    // (1) the FSM row exists — non-null commitment id from the same write tx.
    expect(commitmentId).toEqual(expect.any(String))

    // (1) it appears in a PROJECT-scoped briefing for that project.
    const before = await briefing(userA, {
      selector: { kind: 'project', project: PROJECT },
      mode: 'full',
      now: NOW,
    })
    expect(before.commitments.items.map((c) => c.memoryId)).toContain(id)
    expect(before.commitments.count).toBeGreaterThanOrEqual(1)

    // (1) resolve({ memoryId, status: 'resolved' }) succeeds (keyed on memory id).
    const resolved = await resolveByMemoryId(userA, id, 'resolved', ACTOR)
    expect(resolved).toEqual({ id: commitmentId, status: 'resolved' })

    // ...and a resolved commitment drops out of the open-commitments section.
    const after = await briefing(userA, {
      selector: { kind: 'project', project: PROJECT },
      mode: 'full',
      now: NOW,
    })
    expect(after.commitments.items.map((c) => c.memoryId)).not.toContain(id)
  })

  it('a project blocker surfaces in the project briefing blockers section (no FSM row needed)', async () => {
    const { id } = await remember(
      userA,
      {
        memoryType: 'blocker',
        topic: 'docs deploy blocked',
        content: 'docs site deploy is blocked on the DNS cutover',
        project: PROJECT,
      },
      ACTOR,
    )

    // (2) blockers surface via memories WHERE memory_type = 'blocker' — no commitment row.
    const blockerCommitments = await ownerPool.query(
      'SELECT count(*) AS n FROM commitments WHERE memory_id = $1',
      [id],
    )
    expect(Number(blockerCommitments.rows[0].n)).toBe(0)

    const view = await briefing(userA, {
      selector: { kind: 'project', project: PROJECT },
      mode: 'full',
      now: NOW,
    })
    expect(view.blockers.items.map((b) => b.id)).toContain(id)
    expect(view.blockers.count).toBeGreaterThanOrEqual(1)
  })

  it('a project blocker resolves by archiving its OWN memory and leaves the active-blocker set (issue #271)', async () => {
    const { id, commitmentId } = await remember(
      userA,
      {
        memoryType: 'blocker',
        topic: 'release blocked',
        content: 'release is blocked on the migration review',
        project: PROJECT,
      },
      ACTOR,
    )

    // A blocker is MEMORY-ONLY: remember() never auto-creates a commitment for it.
    expect(commitmentId).toBeUndefined()
    const noFsmRow = await ownerPool.query(
      'SELECT count(*) AS n FROM commitments WHERE memory_id = $1',
      [id],
    )
    expect(Number(noFsmRow.rows[0].n)).toBe(0)

    // It is in the active blockers before resolve.
    const before = await briefing(userA, {
      selector: { kind: 'project', project: PROJECT },
      mode: 'full',
      now: NOW,
    })
    expect(before.blockers.items.map((b) => b.id)).toContain(id)

    // resolve(memoryId) does NOT throw for a blocker — it ARCHIVES the memory.
    // The passed status is ignored for a blocker; the result reports 'archived'.
    const resolved = await resolveByMemoryId(userA, id, 'resolved', ACTOR)
    expect(resolved).toEqual({ id, status: 'archived' })

    // The blocker memory's own status moved active -> archived AND the row was
    // CLOSED bi-temporally (valid_to set) — append-only: a status + valid_to
    // UPDATE, the row is NEVER deleted. The close frees the live content-hash slot.
    const row = await ownerPool.query('SELECT status, valid_to FROM memories WHERE id = $1', [id])
    expect(row.rows[0].status).toBe('archived')
    expect(row.rows[0].valid_to).not.toBeNull()

    // An 'archive' lifecycle audit event was recorded (append-only audit trail).
    const events = await ownerPool.query(
      "SELECT count(*) AS n FROM memory_events WHERE memory_id = $1 AND event_kind = 'archive'",
      [id],
    )
    expect(Number(events.rows[0].n)).toBe(1)

    // ...and it no longer appears in the active-blocker briefing section.
    const after = await briefing(userA, {
      selector: { kind: 'project', project: PROJECT },
      mode: 'full',
      now: NOW,
    })
    expect(after.blockers.items.map((b) => b.id)).not.toContain(id)
  })

  it('a recurring blocker can be re-recorded after the prior one is resolved (Codex P2, PR #282)', async () => {
    // The SAME blocker content. Before the valid_to-close fix, archiving by status
    // alone left the original valid_to IS NULL, so it kept occupying the live
    // content-hash slot in memories_hash_idx and a second remember() with identical
    // content failed forever with DuplicateMemoryError — a recurring blocker could
    // never be re-recorded.
    const blockerInput = {
      memoryType: 'blocker' as const,
      topic: 'flaky deploy',
      content: 'the staging deploy is blocked on the flaky migration step',
      project: PROJECT,
    }

    const first = await remember(userA, blockerInput, ACTOR)
    expect(first.id).toEqual(expect.any(String))

    // Resolve (archive + close) the first occurrence.
    const resolved = await resolveByMemoryId(userA, first.id, 'resolved', ACTOR)
    expect(resolved).toEqual({ id: first.id, status: 'archived' })

    // The SAME content can now be re-recorded: the closed row no longer holds the
    // live content-hash slot, so no DuplicateMemoryError.
    const second = await remember(userA, blockerInput, ACTOR)
    expect(second.id).toEqual(expect.any(String))
    expect(second.id).not.toEqual(first.id)

    // The new blocker surfaces in the active-blocker briefing; the original is
    // archived (closed) and absent from the active set.
    const view = await briefing(userA, {
      selector: { kind: 'project', project: PROJECT },
      mode: 'full',
      now: NOW,
    })
    const activeIds = view.blockers.items.map((b) => b.id)
    expect(activeIds).toContain(second.id)
    expect(activeIds).not.toContain(first.id)

    const originalRow = await ownerPool.query(
      'SELECT status, valid_to FROM memories WHERE id = $1',
      [first.id],
    )
    expect(originalRow.rows[0].status).toBe('archived')
    expect(originalRow.rows[0].valid_to).not.toBeNull()
  })

  it('regression: a commitment remembered WITHOUT a project is absent from a project briefing (root cause)', async () => {
    // This is the dogfood symptom: omitting `project` lands project = NULL, which
    // the briefing's `memories.project = $project` predicate never matches. The
    // commitment row still exists and resolve still works (project-agnostic) — it
    // is ONLY the project-scoped READ that excludes it. Pinned so the conservative
    // fix (thread the caller's project; do NOT invent a global default) is not
    // silently regressed into a surprising default later.
    const { id, commitmentId } = await remember(
      userA,
      {
        memoryType: 'commitment',
        topic: 'unscoped pickup',
        content: 'a commitment with no project label',
      },
      ACTOR,
    )
    expect(commitmentId).toEqual(expect.any(String))

    const projectView = await briefing(userA, {
      selector: { kind: 'project', project: PROJECT },
      mode: 'full',
      now: NOW,
    })
    expect(projectView.commitments.items.map((c) => c.memoryId)).not.toContain(id)

    // It IS visible under the 'all' selector (no project narrowing) and resolves
    // by memory id regardless of project — proving the FSM row was created and the
    // symptom is scoping, not a missing write.
    const allView = await briefing(userA, {
      selector: { kind: 'all' },
      mode: 'full',
      now: NOW,
    })
    expect(allView.commitments.items.map((c) => c.memoryId)).toContain(id)

    const resolved = await resolveByMemoryId(userA, id, 'resolved', ACTOR)
    expect(resolved.status).toBe('resolved')
  })
})

// Issue #165 (with #322's capture-to-action matrix): a deadline written through
// the NATIVE write path drives overdue and expiry exactly like an imported one.
// Synthetic rows only; time is injected, never slept on.
describe('native commitment deadline -> overdue -> expiry (issue #165)', () => {
  const DAY = 24 * 60 * 60 * 1000
  const GRACE = { expiryGraceDays: 14 }
  const at = (days: number) => new Date(NOW.getTime() + days * DAY)
  // The real db sweep, narrowed to the tenant under test.
  const repoFor = (userId: string): SurfacingRepo => ({
    listTenantIds: async () => [userId],
    sweepCommitments: dbSurfacingRepo.sweepCommitments,
  })
  const projectBriefing = (now: Date) =>
    briefing(userA, { selector: { kind: 'project', project: PROJECT }, mode: 'full', now })
  const dated = (dueAt: Date) => ({
    memoryType: 'commitment',
    topic: 'cut the v1.9 release',
    content: 'cut and tag the v1.9 release from staging',
    project: PROJECT,
    dueAt: dueAt.toISOString(),
    owner: 'release-captain',
  })

  it('persists the explicit deadline and owner on the auto-created commitment row', async () => {
    const { id, commitmentId } = await remember(userA, dated(at(1)), ACTOR)

    const row = await ownerPool.query(
      'SELECT id, due_at, owner, status FROM commitments WHERE memory_id = $1',
      [id],
    )
    expect(row.rows[0]).toMatchObject({
      id: commitmentId,
      owner: 'release-captain',
      status: 'open',
    })
    expect(new Date(row.rows[0].due_at).toISOString()).toBe(at(1).toISOString())
  })

  it('reads overdue in the project briefing once past due, expires only after the grace', async () => {
    const { id } = await remember(userA, dated(at(1)), ACTOR)

    const beforeDue = await projectBriefing(at(0))
    expect(beforeDue.overdue.items.map((c) => c.memoryId)).not.toContain(id)
    const listed = beforeDue.commitments.items.find((c) => c.memoryId === id)
    expect(listed).toMatchObject({ dueAt: at(1).toISOString(), overdue: false })

    // Past due, inside the grace: overdue, and the sweep leaves it open (#221).
    const pastDue = at(5)
    expect((await surface(repoFor(userA), pastDue, GRACE)).expired).toBe(0)
    const overdue = await projectBriefing(pastDue)
    expect(overdue.overdue.items.map((c) => c.memoryId)).toContain(id)
    expect(overdue.overdue.items.find((c) => c.memoryId === id)?.overdue).toBe(true)

    // Past the grace: the sweep expires it and it leaves both sections.
    const pastGrace = at(1 + GRACE.expiryGraceDays + 1)
    expect((await surface(repoFor(userA), pastGrace, GRACE)).expired).toBe(1)
    const status = await ownerPool.query('SELECT status FROM commitments WHERE memory_id = $1', [
      id,
    ])
    expect(status.rows[0].status).toBe('expired')
    const after = await projectBriefing(pastGrace)
    expect(after.overdue.items.map((c) => c.memoryId)).not.toContain(id)
    expect(after.commitments.items.map((c) => c.memoryId)).not.toContain(id)
  })

  it('never makes an undated commitment overdue or expires it, whatever the prose says', async () => {
    const { id } = await remember(
      userA,
      {
        memoryType: 'commitment',
        topic: 'undated pickup',
        content: 'finish the docs pass by next Friday',
        project: PROJECT,
      },
      ACTOR,
    )

    const farFuture = at(365)
    expect((await surface(repoFor(userA), farFuture, GRACE)).expired).toBe(0)
    const view = await projectBriefing(farFuture)
    expect(view.overdue.items.map((c) => c.memoryId)).not.toContain(id)
    expect(view.commitments.items.find((c) => c.memoryId === id)).toMatchObject({
      dueAt: null,
      overdue: false,
    })
  })

  it('keeps the deadline, owner and commitment identity across a revise', async () => {
    const first = await remember(userA, dated(at(1)), ACTOR)

    const successor = await revise(
      userA,
      {
        predecessorId: first.id,
        memoryType: 'commitment',
        topic: 'cut the v1.9 release',
        content: 'cut and tag the v1.9 release from staging, with notes',
      },
      ACTOR,
    )

    const row = await ownerPool.query(
      'SELECT id, memory_id, due_at, owner FROM commitments WHERE user_id = $1',
      [userA],
    )
    expect(row.rowCount).toBe(1)
    expect(row.rows[0]).toMatchObject({
      id: first.commitmentId,
      memory_id: successor.id,
      owner: 'release-captain',
    })
    expect(new Date(row.rows[0].due_at).toISOString()).toBe(at(1).toISOString())
    const overdue = await projectBriefing(at(5))
    expect(overdue.overdue.items.map((c) => c.memoryId)).toEqual([successor.id])
  })
})
