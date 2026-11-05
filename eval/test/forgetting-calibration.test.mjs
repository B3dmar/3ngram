// SPDX-License-Identifier: Apache-2.0
// The public calibration fixture (eval/fixtures/README.md) and the pre-registered
// threshold protocol: the fixture is frozen (hash, label checksum, slice mix,
// all-dev), shaped like the candidate query's output, carries no trivial label
// tell, and thresholds selected on it score another fixture frozen. Fake answers
// only: no network, no database, nothing written outside a temp dir.
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  cliOptions,
  DEFAULT_GOLDEN,
  formatReport,
  loadGolden,
  runForgettingEval,
} from '../src/forgetting-eval.mjs'
import {
  barEvidence,
  CALIBRATION_FAKE_ANSWERS,
  CALIBRATION_GOLDEN,
  CALIBRATION_LABELS_SHA256,
  CALIBRATION_SHA256,
  fileSha256,
  labelsSha256,
  loadFrozenThresholds,
  SELECTION_RULE,
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

// Cue words a lexical shortcut would use: update words on a pair's newer side, time-bound words on a single.
const UPDATE_CUE = /\b(since|from|now|after|moved|new|became|changed|switched)\b/i
const TIME_CUE = /\b(during|until|while|this|next|before|week|weekend|day)\b/i

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
        timeCue: (r) => (TIME_CUE.test(r.m.content) ? 1 : 0),
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
        updateCue: (r) => (UPDATE_CUE.test(r.p.newer.content) ? 1 : 0),
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
  for (const m of [...singles, ...neighbours, ...pairs.flatMap((p) => [p.older, p.newer])]) {
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
  // Pinned on the fake answers: archive first reaches 0.97 at 0.70 (0.959 at 0.65 is short of
  // the margin); supersede reaches it only below 10 proposals, so none.
  const selected = { archive: 0.7, supersede: null, conflict: 0.5 }
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
  // The bar reads every item whatever its split label: the mirror's dev and heldout together.
  assert.deepEqual(frozen.barEvidence.archive, frozen.splits.all.precision.archive)
  assert.equal(frozen.barEvidence.recurringEpisodicCollapses, 0)
  assert.equal(frozen.barEvidence.bar.minArchiveProposals, 40)
  // 3/4 archives is short on precision and proposals; zero collapses holds.
  assert.deepEqual(frozen.barEvidence.met, {
    archive: false,
    recurringEpisodicCollapses: true,
    overall: false,
  })
  assert.equal(calibration.barEvidence, undefined, 'no bar evidence from the calibration fixture')
  const report = formatReport(frozen)
  assert.match(report, /frozen thresholds/)
  assert.match(report, /^pass \(built-in thresholds\):/m)
  assert.match(report, /bar evidence, all items whatever their split/)
  assert.match(report, /^ {2}archive 0\.750 \(3\/4\), needs >= 0\.95 over >= 40: not met$/m)
  assert.match(report, /^ {2}episodic collapses 0, needs 0: met$/m)
  assert.equal(frozen.barEvidence.synthetic, true, 'the committed mirror is synthetic')
  assert.match(
    report,
    /^ {2}bar overall \(report-only, enables nothing\): not met \(committed synthetic fixture: never counts\)$/m,
  )
  assert.doesNotMatch(report, /threshold sweep/)

  // Identity is what the bar reads of the labels, not the path, the bytes or the splits: a
  // copy, a symlink, a re-serialised or a re-split file is still the committed mirror. A file
  // whose expected verdict differs for one item stands in for the private set.
  const frozenOn = (goldenPath, name) =>
    runForgettingEval({ goldenPath, outPath: join(dir, name), thresholdsPath: selectPath })
  const mirror = JSON.parse(readFileSync(DEFAULT_GOLDEN, 'utf8'))
  const copy = join(dir, 'copy.json')
  copyFileSync(DEFAULT_GOLDEN, copy)
  const link = join(dir, 'link.json')
  symlinkSync(DEFAULT_GOLDEN, link)
  const minified = join(dir, 'minified.json')
  writeFileSync(minified, JSON.stringify(mirror))
  const [firstId] = Object.keys(mirror.labels)
  const first = mirror.labels[firstId]
  const withLabel = (label) =>
    JSON.stringify({ ...mirror, labels: { ...mirror.labels, [firstId]: label } })
  const resplit = join(dir, 'resplit.json')
  writeFileSync(resplit, withLabel({ ...first, split: first.split === 'dev' ? 'heldout' : 'dev' }))
  for (const [path, name] of [
    [copy, 'copy-out.json'],
    [link, 'link-out.json'],
    [minified, 'minified-out.json'],
    [resplit, 'resplit-out.json'],
  ]) {
    assert.equal((await frozenOn(path, name)).barEvidence.synthetic, true, name)
  }
  // A keep becomes an archive, or anything else becomes a keep; no relatedMemoryId is needed.
  const flipped = first.expected === 'keep' ? 'archive' : 'keep'
  const other = join(dir, 'other.json')
  writeFileSync(other, withLabel({ ...first, expected: flipped, relatedMemoryId: undefined }))
  const personal = await frozenOn(other, 'other-out.json')
  assert.equal(personal.barEvidence.synthetic, false)
  assert.match(
    formatReport(personal),
    /^ {2}bar overall \(report-only, enables nothing\): not met$/m,
  )
})

test('the bar verdict reads the unrounded ratio, not the rounded precision', () => {
  const evidence = (proposed, correct, collapses) =>
    barEvidence({
      precision: {
        archive: {
          proposed,
          correct,
          precision: proposed === 0 ? null : +(correct / proposed).toFixed(4),
        },
      },
      falseCollapses: { count: collapses },
    }).met
  assert.deepEqual(evidence(40, 38, 0), {
    archive: true,
    recurringEpisodicCollapses: true,
    overall: true,
  })
  // 1899/1999 = 0.94997 rounds to 0.95 but sits below the bar.
  assert.equal(evidence(1999, 1899, 0).archive, false)
  assert.equal(evidence(39, 39, 0).archive, false, 'too few proposals')
  assert.equal(evidence(0, 0, 0).archive, false, 'no proposals')
  assert.deepEqual(evidence(40, 40, 1), {
    archive: true,
    recurringEpisodicCollapses: false,
    overall: false,
  })
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
    rule: SELECTION_RULE,
    source: { sha256: CALIBRATION_SHA256, labelsSha256: CALIBRATION_LABELS_SHA256 },
    model: 'jev-x',
    thresholds: { archive: 0.9, supersede: 0.9, conflict: null },
  }
  const forged = [
    [{ source: { ...good.source, sha256: 'f'.repeat(64) } }, /not selected on the pinned/],
    [{ source: { ...good.source, labelsSha256: 'f'.repeat(64) } }, /pinned label checksum/],
    [{ rule: { ...SELECTION_RULE, archive: { minPrecision: 0.9, minProposals: 10 } } }, /rule/],
    [{ thresholds: { ...good.thresholds, archive: 0.83 } }, /archive must be null or a swept/],
    [{ thresholds: { ...good.thresholds, conflict: 2 } }, /conflict must be null or a swept/],
  ]
  for (const [edit, refusal] of forged) {
    assert.throws(() => loadFrozenThresholds(write({ ...good, ...edit })), refusal)
  }
  await assert.rejects(
    runForgettingEval({ outPath: out, thresholdsPath: write(good) }),
    /selected with model jev-x/,
  )
  await assert.rejects(
    runForgettingEval({
      goldenPath: CALIBRATION_GOLDEN,
      outPath: out,
      selectPath: join(dir, 's.json'),
      thresholdsPath: write(good),
    }),
    /cannot be combined/,
  )
})

test('a threshold flag without a path throws instead of falling back', () => {
  for (const args of [
    ['--thresholds'],
    ['--thresholds', '--live'],
    ['--thresholds='],
    ['--select-thresholds'],
    ['--select-thresholds', '--out', 'x.json'],
  ]) {
    assert.throws(() => cliOptions(args), /needs a path/, args.join(' '))
  }
  const options = cliOptions(['--thresholds', 't.json', '--select-thresholds=s.json'])
  assert.deepEqual([options.thresholdsPath, options.selectPath], ['t.json', 's.json'])
  assert.deepEqual(
    [cliOptions([]).thresholdsPath, cliOptions([]).selectPath],
    [undefined, undefined],
  )
})

test('selection takes the lowest qualifying threshold, and none when none qualifies', () => {
  const row = (threshold, proposed, precision) => ({ threshold, proposed, correct: 0, precision })
  const sweep = {
    // 0.96 clears the 0.95 bar but not the deliberate 0.97 margin.
    archive: [row(0.5, 30, 0.9), row(0.55, 20, 0.96), row(0.6, 12, 0.97), row(0.65, 11, 1)],
    supersede: [row(0.5, 9, 1), row(0.55, 4, 1)],
    conflict: [row(0.5, 0, null)],
  }
  assert.deepEqual(selectThresholds(sweep), { archive: 0.6, supersede: null, conflict: null })
  assert.deepEqual(
    [SELECTION_RULE.archive.minPrecision, SELECTION_RULE.supersede.minPrecision],
    [0.97, 0.97],
  )
  assert.deepEqual(
    [SELECTION_RULE.conflict.minPrecision, SELECTION_RULE.conflict.minProposals],
    [0.8, 10],
  )
})
