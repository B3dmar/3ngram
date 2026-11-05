// SPDX-License-Identifier: Apache-2.0
// Pre-registered threshold selection for the forgetting eval
// (docs/concepts/forgetting-pass.mdx, "Eval plan", "Protocol").
//
// Judge thresholds are selected ONLY on the dev split of the public synthetic
// calibration fixture. Every personal item, historical or fresh, is held-out
// evidence, whatever its fixed split label: the private golden set is scored
// with thresholds frozen in a file selected on the pinned fixture, and the
// enablement bar is read over all of its items. Synthetic results never count.
// Report-only: nothing here gates a merge or enables the pass.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
export const CALIBRATION_GOLDEN = join(here, '../fixtures/forgetting-calibration.json')
/** A wiring fake for CI, never judge output: thresholds selected with it are fake too. */
export const CALIBRATION_FAKE_ANSWERS = join(
  here,
  '../fixtures/forgetting-calibration-fake-answers.json',
)

/** The fixture froze before any judge run; a changed byte is a new fixture and a new pre-registration. */
export const CALIBRATION_SHA256 = '7a06d172a117f614ce7f475ccc51dedeed9d1d90b7d6d8d9b2f3a82ef0e464d8'
export const CALIBRATION_LABELS_SHA256 =
  '8aaf06abc1243a575d2e8dd87de81fdcbe1d6b4495144abea8c2e87ffd70a7b0'

/** The swept thresholds, 0.50 to 0.95 in steps of 0.05. */
export const THRESHOLD_GRID = Object.freeze(
  Array.from({ length: 10 }, (_, i) => (50 + 5 * i) / 100),
)

/**
 * Per action, the lowest swept threshold whose dev precision is at least
 * `minPrecision` over at least `minProposals` proposals; none qualifying
 * selects null, which proposes nothing. Archive and supersede aim at 0.97, a
 * deliberate margin over the 0.95 bar: a wrong archive costs more than a
 * missed one, and selecting at the bar leaves no held-out margin.
 */
export const SELECTION_RULE = Object.freeze({
  archive: Object.freeze({ minPrecision: 0.97, minProposals: 10 }),
  supersede: Object.freeze({ minPrecision: 0.97, minProposals: 10 }),
  conflict: Object.freeze({ minPrecision: 0.8, minProposals: 10 }),
})

/** The ADR's enablement bar, read over every personal item with frozen thresholds. */
export const ENABLEMENT_BAR = Object.freeze({
  archivePrecision: 0.95,
  minArchiveProposals: 40,
  recurringEpisodicCollapses: 0,
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

/** Refuse a selection off the calibration fixture, and a selection that is also frozen. */
export function assertThresholdMode({ selectPath, thresholdsPath }, calibration) {
  if (selectPath === undefined) return
  if (thresholdsPath !== undefined) {
    throw new Error('--select-thresholds and --thresholds cannot be combined')
  }
  if (!calibration) {
    throw new Error('thresholds are selected only on eval/fixtures/forgetting-calibration.json')
  }
}

/** Write the thresholds the rule selects on `metrics`' dev sweep, with their provenance. */
export function writeSelection(path, metrics, mode) {
  const selection = {
    version: 1,
    rule: SELECTION_RULE,
    source: {
      fixture: 'forgetting-calibration.json',
      sha256: metrics.golden.sha256,
      labelsSha256: metrics.golden.labelsSha256,
      split: metrics.thresholds.split,
    },
    mode,
    model: metrics.model,
    thresholds: selectThresholds(metrics.thresholds),
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(selection, null, 2)}\n`)
  return selection.thresholds
}

/**
 * Read a thresholds file and refuse one that does not match what selection
 * writes for the pinned fixture. An ACCIDENT GUARD against applying the wrong
 * file, not proof of provenance: a hand-written file with these fields passes.
 */
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
  if (raw.source.labelsSha256 !== CALIBRATION_LABELS_SHA256) {
    throw new Error('thresholds: labelsSha256 is not the pinned label checksum')
  }
  if (!isDeepStrictEqual(raw.rule, { ...SELECTION_RULE })) {
    throw new Error('thresholds: rule is not the pre-registered SELECTION_RULE')
  }
  if (typeof raw.model !== 'string') throw new Error('thresholds: model must be a string')
  for (const action of Object.keys(SELECTION_RULE)) {
    const t = raw.thresholds?.[action]
    if (!(t === null || THRESHOLD_GRID.includes(t))) {
      throw new Error(`thresholds: ${action} must be null or a swept threshold`)
    }
  }
  return raw
}

/**
 * The bar's inputs over every labelled item, whatever its split label, and whether each
 * condition holds. Precision is compared as the unrounded ratio of the counts, never the
 * 4-decimal figure, so 1899/1999 cannot pass as 0.95. Report-only: `met` enables nothing.
 */
export function barEvidence(all) {
  const archive = all.precision.archive
  const collapses = all.falseCollapses.count
  const archiveMet =
    archive.proposed >= ENABLEMENT_BAR.minArchiveProposals &&
    archive.correct / archive.proposed >= ENABLEMENT_BAR.archivePrecision
  const collapsesMet = collapses <= ENABLEMENT_BAR.recurringEpisodicCollapses
  return {
    archive,
    recurringEpisodicCollapses: collapses,
    bar: ENABLEMENT_BAR,
    met: {
      archive: archiveMet,
      recurringEpisodicCollapses: collapsesMet,
      overall: archiveMet && collapsesMet,
    },
  }
}
