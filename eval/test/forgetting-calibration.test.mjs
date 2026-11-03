// SPDX-License-Identifier: Apache-2.0
// The public calibration fixture (eval/fixtures/README.md) and the pre-registered
// threshold protocol: the fixture is frozen (hash, label checksum, slice mix,
// all-dev), shaped like the candidate query's output, carries no trivial label
// tell, and thresholds selected on it score another fixture frozen. Fake answers
// only: no network, no database, nothing written outside a temp dir.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { formatReport, loadGolden, runForgettingEval } from '../src/forgetting-eval.mjs'
import {
  CALIBRATION_FAKE_ANSWERS,
  CALIBRATION_GOLDEN,
  CALIBRATION_LABELS_SHA256,
  CALIBRATION_SHA256,
  fileSha256,
  labelsSha256,
  loadFrozenThresholds,
  selectThresholds,
} from '../src/forgetting-thresholds.mjs'

const golden = loadGolden(CALIBRATION_GOLDEN)
const { singles, pairs, neighbours } = golden.candidates
const labels = Object.values(golden.labels)
function count(xs, key) {
  const counts = {}
  for (const x of xs) counts[x[key]] = (counts[x[key]] ?? 0) + 1
  return counts
}
const tmp = () => mkdtempSync(join(tmpdir(), 'forgetting-calibration-'))

test('the calibration fixture is frozen: hashes, slice mix, every label dev', () => {
  assert.equal(fileSha256(CALIBRATION_GOLDEN), CALIBRATION_SHA256)
  assert.equal(labelsSha256(golden.labels), CALIBRATION_LABELS_SHA256)
  assert.deepEqual(count(labels, 'slice'), {
    'stale-archive': 60,
    'conflicting-pair': 40,
    'still-valid': 60,
    'recurring-episodic': 30,
  })
  assert.deepEqual(count(labels, 'expected'), {
    archive: 60,
    supersede: 25,
    conflict: 15,
    keep: 90,
  })
  assert.deepEqual(count(labels, 'split'), { dev: 190 })
})

test('every label is a judged candidate, in the candidate query shape', () => {
  const staleBefore = golden.now.getTime() - 30 * 86_400_000
  const judged = new Set([...singles.map((m) => m.id), ...pairs.map((p) => p.older.id)])
  assert.equal(judged.size, labels.length)
  for (const id of Object.keys(golden.labels)) assert.ok(judged.has(id))
  singles.forEach((m, i) => {
    assert.ok(m.lastTouchedAt.getTime() < staleBefore, 'every single is stale')
    assert.ok(i === 0 || singles[i - 1].lastTouchedAt <= m.lastTouchedAt, 'most stale first')
    assert.ok(m.content.length <= 1_200)
  })
  pairs.forEach((p, i) => {
    const { older: o, newer: n } = p
    assert.ok(p.similarity >= 0.82 && o.recordedAt < n.recordedAt)
    assert.deepEqual([o.memoryType, o.scope, o.project], [n.memoryType, n.scope, n.project])
    assert.equal(p.olderStale, o.lastTouchedAt.getTime() < staleBefore)
    const prev = pairs[i - 1]
    const ranked =
      !prev ||
      (prev.olderStale === p.olderStale ? prev.similarity >= p.similarity : prev.olderStale)
    assert.ok(ranked, 'stale-older pairs first, then by similarity')
    const label = golden.labels[o.id]
    if (label.expected !== 'keep') assert.equal(label.relatedMemoryId, n.id)
  })
  const byId = new Map(singles.map((m) => [m.id, m]))
  assert.ok(singles.every((m) => neighbours.filter((n) => n.forId === m.id).length <= 3))
  for (const n of neighbours) {
    const single = byId.get(n.forId)
    assert.ok(single && n.memoryType === single.memoryType && n.recordedAt > single.recordedAt)
    // A same-type neighbour at the floor would have been a pair; series episodes are never paired.
    const ceiling = ['event', 'note'].includes(n.memoryType) ? 1 : 0.82
    assert.ok(n.content.length <= 300 && n.similarity < ceiling)
  }
})

/** Best one-feature threshold rule's accuracy above the majority baseline. */
function stumpGain(xs, ys) {
  const pos = ys.filter(Boolean).length
  const base = Math.max(pos, ys.length - pos)
  const order = xs.map((x, i) => [x, ys[i]]).sort((a, b) => a[0] - b[0])
  let best = base
  let leftPos = 0
  order.forEach(([x, y], i) => {
    leftPos += y ? 1 : 0
    if (order[i + 1]?.[0] === x) return
    const left = i + 1
    best = Math.max(best, left - 2 * leftPos + pos, ys.length - left + 2 * leftPos - pos)
  })
  return (best - base) / ys.length
}

test('no label is recoverable from a trivial feature', () => {
  const now = golden.now.getTime()
  const age = (d) => (now - d.getTime()) / 86_400_000
  const nb = (m) => neighbours.filter((n) => n.forId === m.id)
  const single = singles
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => golden.labels[m.id].slice !== 'recurring-episodic')
  const tasks = [
    [
      'archive vs still-valid singles',
      single,
      (r) => golden.labels[r.m.id].expected === 'archive',
      {
        length: (r) => r.m.content.length,
        position: (r) => r.i,
        age: (r) => age(r.m.lastTouchedAt),
        neighbours: (r) => nb(r.m).length,
        topSimilarity: (r) => Math.max(0, ...nb(r.m).map((n) => n.similarity)),
      },
    ],
    ...['supersede', 'conflict', 'keep'].map((want) => [
      `${want} vs other pairs`,
      pairs.map((p, i) => ({ p, i })),
      (r) => golden.labels[r.p.older.id].expected === want,
      {
        similarity: (r) => r.p.similarity,
        position: (r) => r.i,
        newerLength: (r) => r.p.newer.content.length,
        lengthGap: (r) => r.p.newer.content.length - r.p.older.content.length,
        olderAge: (r) => age(r.p.older.lastTouchedAt),
      },
    ]),
  ]
  for (const [task, rows, isPositive, features] of tasks) {
    for (const [name, feature] of Object.entries(features)) {
      const gain = stumpGain(rows.map(feature), rows.map(isPositive))
      assert.ok(gain <= 0.15, `${task}: ${name} recovers labels (gain ${gain.toFixed(3)})`)
    }
  }
  const giveaway =
    /\b(obsolete|supersed\w*|deprecat\w*|outdated|no longer|stale|legacy|archiv\w*|replac\w*|instead of|anymore|formerly|previously|used to|old|expired)\b/i
  for (const m of [...singles, ...pairs.flatMap((p) => [p.older, p.newer])]) {
    assert.ok(!giveaway.test(`${m.topic} ${m.content}`), `give-away word in ${m.id}`)
  }
})

test('thresholds selected on the calibration dev split score another fixture frozen', async () => {
  const dir = tmp()
  const selectPath = join(dir, 'thresholds.json')
  const calibration = await runForgettingEval({
    goldenPath: CALIBRATION_GOLDEN,
    answersPath: CALIBRATION_FAKE_ANSWERS,
    outPath: join(dir, 'calibration.json'),
    selectPath,
  })
  assert.equal(calibration.golden.calibration, true)
  assert.equal(calibration.splits.dev.labelled, 190)
  // Pinned on the fake answers: supersede reaches 0.95 only below 10 proposals, so none.
  const selected = { archive: 0.65, supersede: null, conflict: 0.5 }
  assert.deepEqual(calibration.selected, selected)
  assert.match(formatReport(calibration), /selected by the pre-registered rule/)
  const file = loadFrozenThresholds(selectPath)
  assert.deepEqual(
    [file.source.sha256, file.model, file.thresholds],
    [CALIBRATION_SHA256, 'fake-judgment', selected],
  )

  const frozen = await runForgettingEval({
    outPath: join(dir, 'mirror.json'),
    thresholdsPath: selectPath,
  })
  assert.deepEqual(frozen.thresholds.frozen, selected)
  assert.equal(frozen.thresholds.split, undefined, 'frozen scoring carries no sweep')
  assert.equal(frozen.golden.calibration, false)
  assert.deepEqual(frozen.splits.all.precision.archive, {
    proposed: 4,
    correct: 3,
    precision: 0.75,
  })
  assert.equal(frozen.splits.all.precision.supersede.proposed, 0)
  assert.equal(frozen.verdicts.proposed, 5)
  const report = formatReport(frozen)
  assert.match(report, /frozen thresholds/)
  assert.doesNotMatch(report, /threshold sweep/)
})

test('the protocol refuses a selection off the fixture and foreign thresholds', async () => {
  const dir = tmp()
  const out = join(dir, 'out.json')
  await assert.rejects(
    runForgettingEval({ outPath: out, selectPath: join(dir, 's.json') }),
    /selected only on/,
  )
  let files = 0
  const write = (body) => {
    files += 1
    const path = join(dir, `thresholds-${files}.json`)
    writeFileSync(path, JSON.stringify(body))
    return path
  }
  const good = {
    version: 1,
    source: { sha256: CALIBRATION_SHA256 },
    model: 'jev-x',
    thresholds: { archive: 0.9, supersede: 0.9, conflict: null },
  }
  assert.throws(
    () => loadFrozenThresholds(write({ ...good, source: { sha256: 'f'.repeat(64) } })),
    /not selected on the pinned/,
  )
  assert.throws(
    () => loadFrozenThresholds(write({ ...good, thresholds: { archive: 2 } })),
    /archive must be null/,
  )
  await assert.rejects(
    runForgettingEval({ outPath: out, thresholdsPath: write(good) }),
    /selected with model jev-x/,
  )
})

test('selection takes the lowest qualifying threshold, and none when none qualifies', () => {
  const row = (threshold, proposed, precision) => ({ threshold, proposed, correct: 0, precision })
  const sweep = {
    archive: [row(0.5, 30, 0.9), row(0.55, 20, 0.96), row(0.6, 12, 1)],
    supersede: [row(0.5, 9, 1), row(0.55, 4, 1)],
    conflict: [row(0.5, 0, null)],
  }
  assert.deepEqual(selectThresholds(sweep), { archive: 0.55, supersede: null, conflict: null })
})
