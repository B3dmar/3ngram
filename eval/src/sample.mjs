// SPDX-License-Identifier: Apache-2.0
// Pinned, stratified LongMemEval-S samples (#449).
//
// ADVISORY ONLY: nothing here gates a PR. A sample fixture lists question ids
// drawn from ONE pinned upstream release, whose sha256 it records. It never
// holds upstream content: the dataset stays in the gitignored cache. Scoring
// the same ids every night means a night-over-night change comes from the
// product, not from a different question mix.
import { isAbstention } from './lib.mjs'

/** Per-type quotas for the 50-question sample: at least 5 of every type. */
export const SAMPLE_QUOTAS = Object.freeze({
  'multi-session': 12,
  'temporal-reasoning': 12,
  'knowledge-update': 8,
  'single-session-user': 7,
  'single-session-assistant': 6,
  'single-session-preference': 5,
})

/**
 * Abstention questions in the sample, counted inside their type's quota.
 * Retrieval skips them, as LongMemEval's protocol does (no ground-truth answer
 * location); they are in the sample for the answer-level judge.
 */
export const SAMPLE_ABSTENTION = 5

/** mulberry32: a small seeded PRNG, so one seed reproduces one sample exactly. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled(items, rng) {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Pick question ids to fill each type's quota, `abstention` of them abstention
 * questions, reproducibly from `seed`. Candidates are sorted by id before the
 * seeded shuffle, so the result depends on the dataset's content, not its order.
 * Throws when a quota cannot be met: a short sample is never returned.
 */
export function selectSample(
  instances,
  { seed, quotas = SAMPLE_QUOTAS, abstention = SAMPLE_ABSTENTION },
) {
  const rng = mulberry32(seed)
  const byId = (a, b) => a.question_id.localeCompare(b.question_id)
  const inQuota = (q) => Object.hasOwn(quotas, q.question_type)
  const taken = Object.fromEntries(Object.keys(quotas).map((type) => [type, []]))

  let abstentionTaken = 0
  const abstentionPool = instances.filter((q) => inQuota(q) && isAbstention(q.question_id))
  for (const q of shuffled(abstentionPool.sort(byId), rng)) {
    if (abstentionTaken === abstention) break
    if (taken[q.question_type].length >= quotas[q.question_type]) continue
    taken[q.question_type].push(q.question_id)
    abstentionTaken++
  }
  if (abstentionTaken < abstention) {
    throw new Error(`only ${abstentionTaken} of ${abstention} abstention questions fit the quotas`)
  }

  for (const [type, quota] of Object.entries(quotas)) {
    const need = quota - taken[type].length
    const pool = instances.filter((q) => q.question_type === type && !isAbstention(q.question_id))
    if (pool.length < need) {
      throw new Error(`question type ${type}: need ${need}, have ${pool.length}`)
    }
    taken[type].push(
      ...shuffled(pool.sort(byId), rng)
        .slice(0, need)
        .map((q) => q.question_id),
    )
  }
  return Object.values(taken).flat()
}

/**
 * Restrict normalized questions to a sample, in the sample's order. Refuses a
 * sample drawn from a different release, a duplicate id or an id the dataset
 * lacks: scoring a partial or different question set would misreport the lane.
 */
export function applySample(questions, sample, datasetSha256) {
  const pinned = sample?.dataset?.sha256
  if (!pinned || pinned !== datasetSha256) {
    throw new Error(
      `sample was drawn from dataset sha256 ${pinned ?? '(none)'}; the scored dataset is ${datasetSha256 || '(unverified)'}`,
    )
  }
  const ids = sample.question_ids ?? []
  if (new Set(ids).size !== ids.length) throw new Error('sample lists a question id twice')
  const byId = new Map(questions.map((q) => [q.question_id, q]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    throw new Error(`${missing.length} sample id(s) not in the dataset, e.g. ${missing[0]}`)
  }
  return ids.map((id) => byId.get(id))
}
