// SPDX-License-Identifier: Apache-2.0
// Shared fixture for the search-filters integration suites (V1
// search-filters.int.test.ts, V2 search-filters-v2.int.test.ts — split for the
// 500-line file cap). ONE seed matrix + helpers so both suites assert against
// the SAME rows and cannot drift.
//
// Embeddings are the same deterministic FakeGateway-style hash vectors the
// sibling search suite uses — a WIRING fake, so assertions are about candidate
// membership and filtering, not semantic ranking (the golden oracle's job).
import { ownerPool } from './helpers.js'

const EMBEDDING_DIMENSIONS = 1536

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function fakeEmbedding(text: string, dims = EMBEDDING_DIMENSIONS): number[] {
  const rand = mulberry32(fnv1a(text))
  const v = Array.from({ length: dims }, () => rand() * 2 - 1)
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map((x) => x / norm)
}

// All rows share the lexical term 'alpha' so the FTS leg recalls the whole set;
// filters are the only thing that should narrow the result. Distinct attributes
// across rows let each filter axis be asserted in isolation.
export interface SeedRow {
  key: string
  memoryType: string
  scope: string
  project: string | null
  status: string
  validFrom: string
  validTo: string | null
  recordedAt: string
}

export const SEED: SeedRow[] = [
  // dimensional matrix — all active, current; recorded_at runs one day apart
  // (2026-01-01..01-06) so the V2 range bounds can slice it deterministically.
  {
    key: 'd_dec_work_p1',
    memoryType: 'decision',
    scope: 'work',
    project: 'p1',
    status: 'active',
    validFrom: '2026-01-01',
    validTo: null,
    recordedAt: '2026-01-01',
  },
  {
    key: 'd_note_work_p1',
    memoryType: 'note',
    scope: 'work',
    project: 'p1',
    status: 'active',
    validFrom: '2026-01-02',
    validTo: null,
    recordedAt: '2026-01-02',
  },
  {
    key: 'd_dec_personal_p1',
    memoryType: 'decision',
    scope: 'personal',
    project: 'p1',
    status: 'active',
    validFrom: '2026-01-03',
    validTo: null,
    recordedAt: '2026-01-03',
  },
  {
    key: 'd_dec_work_p2',
    memoryType: 'decision',
    scope: 'work',
    project: 'p2',
    status: 'active',
    validFrom: '2026-01-04',
    validTo: null,
    recordedAt: '2026-01-04',
  },
  {
    key: 'd_dec_work_null',
    memoryType: 'decision',
    scope: 'work',
    project: null,
    status: 'active',
    validFrom: '2026-01-05',
    validTo: null,
    recordedAt: '2026-01-05',
  },
  {
    key: 'd_archived',
    memoryType: 'fact',
    scope: 'work',
    project: 'p1',
    status: 'archived',
    validFrom: '2026-01-06',
    validTo: null,
    recordedAt: '2026-01-06',
  },
]

export async function seedRow(userId: string, r: SeedRow): Promise<string> {
  const embedding = fakeEmbedding(r.key)
  const res = await ownerPool.query(
    `INSERT INTO memories
       (user_id, memory_type, topic, content, content_hash, scope, project, status,
        embedding, valid_from, valid_to, recorded_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10::timestamptz,$11,$12::timestamptz,$10::timestamptz)
     RETURNING id`,
    [
      userId,
      r.memoryType,
      r.key,
      `alpha ${r.key}`,
      `filter-${userId}-${r.key}`,
      r.scope,
      r.project,
      r.status,
      `[${embedding.join(',')}]`,
      r.validFrom,
      r.validTo,
      r.recordedAt,
    ],
  )
  return res.rows[0].id
}

/** Seed the full dimensional matrix for one tenant; returns key -> memory id. */
export async function seedMatrix(userId: string): Promise<Map<string, string>> {
  const idByKey = new Map<string, string>()
  for (const r of SEED) idByKey.set(r.key, await seedRow(userId, r))
  return idByKey
}

/** Map result ids back to seed keys (unknown ids dropped). */
export function keysOf(idByKey: Map<string, string>, hits: { id: string }[]): string[] {
  const byId = new Map([...idByKey.entries()].map(([k, v]) => [v, k] as const))
  return hits.map((h) => byId.get(h.id)).filter((k): k is string => k !== undefined)
}

// FTS-only weights isolate the filter behaviour from vector/recency noise: every
// row matches 'alpha', so any narrowing is the filter's doing alone.
export const FTS_ONLY = { fts: 1, recency: 0, vector: 0 }
export const BIG = 100
