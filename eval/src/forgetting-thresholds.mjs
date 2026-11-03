// SPDX-License-Identifier: Apache-2.0
// Pre-registered threshold selection for the forgetting eval
// (docs/concepts/forgetting-pass.mdx, "Eval plan", "Protocol").
//
// Judge thresholds are selected ONLY on the dev split of the public synthetic
// calibration fixture. Every personal item, historical or fresh, is held-out
// evidence: the private golden set is scored with thresholds frozen in a file
// that this module refuses unless it was selected on the pinned fixture.
// Report-only: nothing here gates a merge or enables the pass.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const CALIBRATION_GOLDEN = join(here, '../fixtures/forgetting-calibration.json')
/** A wiring fake for CI, never judge output: thresholds selected with it are fake too. */
export const CALIBRATION_FAKE_ANSWERS = join(
  here,
  '../fixtures/forgetting-calibration-fake-answers.json',
)

/** The fixture froze before any judge run; a changed byte is a new fixture and a new pre-registration. */
export const CALIBRATION_SHA256 = '6e3653884804a257255bf3c8a5fa7997fd637a081d50009207f95e59a6920b3b'
export const CALIBRATION_LABELS_SHA256 =
  '8aaf06abc1243a575d2e8dd87de81fdcbe1d6b4495144abea8c2e87ffd70a7b0'

/**
 * Per action, the lowest swept threshold whose dev precision is at least
 * `minPrecision` over at least `minProposals` proposals. No qualifying
 * threshold selects null, and a null threshold proposes nothing.
 */
export const SELECTION_RULE = Object.freeze({
  archive: Object.freeze({ minPrecision: 0.95, minProposals: 10 }),
  supersede: Object.freeze({ minPrecision: 0.95, minProposals: 10 }),
  conflict: Object.freeze({ minPrecision: 0.8, minProposals: 10 }),
})

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const fileSha256 = (path) => sha256(readFileSync(path))

/** Order-independent checksum over each label's id, slice, expected verdict, related id and split. */
export function labelsSha256(labels) {
  const rows = Object.keys(labels)
    .sort()
    .map((id) => {
      const l = labels[id]
      return [id, l.slice, l.expected, l.relatedMemoryId ?? null, l.split]
    })
  return sha256(JSON.stringify(rows))
}

/** Apply the rule to a `thresholdSweep` result. */
export function selectThresholds(sweep, rule = SELECTION_RULE) {
  return Object.fromEntries(
    Object.entries(rule).map(([action, r]) => {
      const row = sweep[action].find(
        (x) => x.proposed >= r.minProposals && x.precision >= r.minPrecision,
      )
      return [action, row?.threshold ?? null]
    }),
  )
}

/** The proposal predicate under frozen thresholds, in place of the pass's built-in ones. */
export function proposedUnder(thresholds) {
  return (v) =>
    v.action !== 'keep' && thresholds[v.action] !== null && v.probability >= thresholds[v.action]
}

/** Read a thresholds file; refuse one not selected on the pinned calibration fixture. */
export function loadFrozenThresholds(path) {
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`thresholds file is missing or not valid JSON: ${path}`)
  }
  if (raw?.version !== 1) throw new Error('thresholds: version must be 1')
  if (raw.source?.sha256 !== CALIBRATION_SHA256) {
    throw new Error('thresholds were not selected on the pinned calibration fixture')
  }
  if (typeof raw.model !== 'string') throw new Error('thresholds: model must be a string')
  for (const action of Object.keys(SELECTION_RULE)) {
    const t = raw.thresholds?.[action]
    if (!(t === null || (typeof t === 'number' && t >= 0 && t <= 1))) {
      throw new Error(`thresholds: ${action} must be null or a number in [0, 1]`)
    }
  }
  return raw
}
