// SPDX-License-Identifier: Apache-2.0
// Forgetting-pass eval harness (docs/concepts/forgetting-pass.mdx, "Eval plan").
//
// REPORT-ONLY, NOT GATED: nothing here changes an exit code on a metric, and
// run.mjs never imports this module (the gate runs with no install). The pass
// stays report-only until the ADR's bars hold on the held-out split: archive
// precision >= 0.95 over >= 40 proposals, and zero recurring-episodic collapses.
//
// HOW IT RUNS. The real `runForgettingPass` is driven through an injected
// in-memory ForgettingRepo built from a golden file: the candidates are what the
// candidate query returned, `stage()` captures every verdict (dismissed ones
// included, for calibration) and writes nothing. No database is involved.
// The judge is the FakeGateway fed with recorded answers keyed by question ref
// (the default, deterministic path), or the live Jev gateway with --live, which
// skips cleanly when JEV_API_KEY / JEV_MODEL are not set.
//
// The golden set itself is PRIVATE (real memories of one consenting account; see
// eval/fixtures/README.md for the schema and eval/private/ in .gitignore). The
// committed fixtures/forgetting-synthetic.json is a small invented mirror that
// exercises every slice so CI can test the wiring.
//
// Observability (hard rule 6): the report and the out file carry memory IDS,
// counts and scores only. No topic or content string is ever printed or written.
//
// Usage: node eval/src/forgetting-eval.mjs [--golden <path>] [--answers <path>]
//          [--live] [--out <path>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseFlag } from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_GOLDEN = join(here, '../fixtures/forgetting-synthetic.json')
export const DEFAULT_ANSWERS = join(here, '../fixtures/forgetting-synthetic-answers.json')
export const DEFAULT_OUT = join(here, '../../eval-metrics/forgetting.json')

/** Mirrors core's FORGET_DECIDE_OPERATION (not exported): the key the fake answers under. */
export const FORGET_DECIDE_OPERATION = 'memory.forget.decide'

export const SLICES = ['stale-archive', 'conflicting-pair', 'still-valid', 'recurring-episodic']
export const EXPECTED = ['archive', 'supersede', 'conflict', 'keep']
export const SPLITS = ['dev', 'heldout']
const PROPOSAL_ACTIONS = ['archive', 'supersede', 'conflict']
/** Any tenant id: the fixture repo ignores it, and nothing is written anywhere. */
const EVAL_USER = '00000000-0000-7000-8000-00000000e7a1'
const ECE_BINS = 10

const round = (n) => +n.toFixed(4)

function readJson(path, what) {
  if (!existsSync(path)) throw new Error(`${what} file not found: ${path}`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${what} file is not valid JSON: ${path} (${error.message})`)
  }
}

function reviveDate(value, where) {
  const date = new Date(value)
  if (typeof value !== 'string' || Number.isNaN(date.getTime())) {
    throw new Error(`golden: ${where} is not an ISO date string`)
  }
  return date
}

function reviveMemory(m, where) {
  if (typeof m?.id !== 'string' || typeof m.memoryType !== 'string') {
    throw new Error(`golden: ${where} needs string id and memoryType`)
  }
  return {
    ...m,
    recordedAt: reviveDate(m.recordedAt, `${where}.recordedAt`),
    lastTouchedAt: reviveDate(m.lastTouchedAt, `${where}.lastTouchedAt`),
  }
}

/** Read and validate a golden file; dates come back as Date objects. */
export function loadGolden(path) {
  const raw = readJson(path, 'golden')
  if (raw.version !== 1) throw new Error('golden: version must be 1')
  const c = raw.candidates
  for (const key of ['singles', 'neighbours', 'pairs']) {
    if (!Array.isArray(c?.[key])) throw new Error(`golden: candidates.${key} must be an array`)
  }
  if (raw.labels === null || typeof raw.labels !== 'object') {
    throw new Error('golden: labels must be an object keyed by memory id')
  }
  for (const [id, label] of Object.entries(raw.labels)) {
    if (!SLICES.includes(label?.slice)) throw new Error(`golden: label ${id} has an unknown slice`)
    if (!EXPECTED.includes(label.expected)) {
      throw new Error(`golden: label ${id} has an unknown expected verdict`)
    }
    if (!SPLITS.includes(label.split)) throw new Error(`golden: label ${id} has an unknown split`)
  }
  return {
    now: raw.now === undefined ? new Date() : reviveDate(raw.now, 'now'),
    labels: raw.labels,
    candidates: {
      singles: c.singles.map((m, i) => reviveMemory(m, `singles[${i}]`)),
      neighbours: c.neighbours.map((n, i) => ({
        ...n,
        recordedAt: reviveDate(n.recordedAt, `neighbours[${i}].recordedAt`),
      })),
      pairs: c.pairs.map((p, i) => ({
        ...p,
        older: reviveMemory(p.older, `pairs[${i}].older`),
        newer: reviveMemory(p.newer, `pairs[${i}].newer`),
      })),
    },
  }
}

/** The pass's repo seam, backed by the golden candidates. Every verdict is captured in `staged`. */
export function createFixtureRepo(candidates) {
  const staged = []
  const repo = {
    isJudgmentEnabled: async () => true,
    readCandidates: async () => candidates,
    stage: async (_userId, verdicts) => {
      staged.push(...verdicts)
      return verdicts.length
    },
    recordUsage: async () => undefined,
  }
  return { repo, staged }
}

/** Memory id -> type, over every memory the candidates name. */
export function memoryTypes(candidates) {
  const types = new Map()
  for (const m of candidates.singles) types.set(m.id, m.memoryType)
  for (const n of candidates.neighbours) types.set(n.id, n.memoryType)
  for (const p of candidates.pairs) {
    types.set(p.older.id, p.older.memoryType)
    types.set(p.newer.id, p.newer.memoryType)
  }
  return types
}

const isProposed = (v) => v.action !== 'keep' && v.dismissed !== true

/** A verdict is correct when its action, and its related memory where labelled, match the label. */
function isCorrect(verdict, label) {
  if (verdict.action !== label.expected) return false
  return label.relatedMemoryId === undefined || verdict.relatedMemoryId === label.relatedMemoryId
}

function precision(verdicts, labels) {
  const correct = verdicts.filter((v) => isCorrect(v, labels[v.memoryId])).length
  return {
    proposed: verdicts.length,
    correct,
    precision: verdicts.length === 0 ? null : round(correct / verdicts.length),
  }
}

/** Expected calibration error over `bins` equal-width probability bins. */
export function calibrationError(scored, bins = ECE_BINS) {
  const buckets = Array.from({ length: bins }, () => ({ n: 0, confidence: 0, correct: 0 }))
  for (const { probability, correct } of scored) {
    const b = buckets[Math.min(bins - 1, Math.floor(probability * bins))]
    b.n += 1
    b.confidence += probability
    b.correct += correct ? 1 : 0
  }
  let ece = 0
  for (const b of buckets) {
    if (b.n > 0) ece += (b.n / scored.length) * Math.abs(b.correct / b.n - b.confidence / b.n)
  }
  return {
    verdicts: scored.length,
    value: scored.length === 0 ? null : round(ece),
    bins: buckets.map((b, i) => ({
      from: round(i / bins),
      n: b.n,
      accuracy: b.n === 0 ? null : round(b.correct / b.n),
      confidence: b.n === 0 ? null : round(b.confidence / b.n),
    })),
  }
}

/**
 * Score one set of labels against the captured verdicts. A labelled memory with
 * no verdict was excluded upstream and counts as kept: nothing was proposed.
 */
export function scoreLabels(verdicts, labels, types) {
  const labelled = verdicts.filter((v) => Object.hasOwn(labels, v.memoryId))
  const proposed = labelled.filter(isProposed)
  const byAction = (action) => proposed.filter((v) => v.action === action)
  const byType = {}
  for (const v of proposed.filter((v) => v.action !== 'conflict')) {
    const type = types.get(v.memoryId) ?? 'unknown'
    byType[type] ??= {}
    byType[type][v.action] = precision(
      byAction(v.action).filter((x) => types.get(x.memoryId) === type),
      labels,
    )
  }
  const inSlice = (slice) => Object.keys(labels).filter((id) => labels[id].slice === slice)
  const stillValid = inSlice('still-valid')
  const episodic = inSlice('recurring-episodic')
  const proposedIds = new Set(proposed.map((v) => v.memoryId))
  const collapsed = episodic.filter((id) =>
    proposed.some((v) => v.memoryId === id && v.action !== 'conflict'),
  )
  const kept = stillValid.filter((id) => !proposedIds.has(id)).length
  return {
    labelled: Object.keys(labels).length,
    precision: {
      archive: precision(byAction('archive'), labels),
      supersede: precision(byAction('supersede'), labels),
      combined: precision([...byAction('archive'), ...byAction('supersede')], labels),
      conflict: precision(byAction('conflict'), labels),
      byType,
    },
    keepRate: {
      stillValid: stillValid.length,
      kept,
      rate: stillValid.length === 0 ? null : round(kept / stillValid.length),
    },
    falseCollapses: {
      recurringEpisodic: episodic.length,
      count: collapsed.length,
      memoryIds: collapsed,
    },
    ece: calibrationError(
      labelled.map((v) => ({
        probability: v.probability,
        correct: isCorrect(v, labels[v.memoryId]),
      })),
    ),
  }
}

/** Precision and proposal count per action at thresholds 0.50..0.95, over labelled verdicts. */
export function thresholdSweep(verdicts, labels) {
  const labelled = verdicts.filter((v) => Object.hasOwn(labels, v.memoryId))
  const sweep = {}
  for (const action of PROPOSAL_ACTIONS) {
    sweep[action] = []
    for (let k = 50; k <= 95; k += 5) {
      const threshold = k / 100
      const at = labelled.filter((v) => v.action === action && v.probability >= threshold)
      sweep[action].push({ threshold, ...precision(at, labels) })
    }
  }
  return sweep
}

function pickSplit(labels, split) {
  return Object.fromEntries(Object.entries(labels).filter(([, l]) => l.split === split))
}

/** Build the judge: recorded answers through the fake, or the live Jev gateway from env. */
async function createGateway({ live, answersPath, env }) {
  const llm = await import('@3ngram/llm')
  if (!live) {
    const answers = readJson(answersPath, 'answers')
    const gateway = llm.createFakeGateway({ decisions: { [FORGET_DECIDE_OPERATION]: answers } })
    return { gateway, mode: 'fake' }
  }
  // `||`: CI exports optional secrets as '', so empty string is unset (judge.mjs precedent).
  const apiKey = env.JEV_API_KEY || ''
  const model = env.JEV_MODEL || ''
  if (!apiKey || !model) return { skipReason: 'JEV_API_KEY and JEV_MODEL not set' }
  const gateway = llm.createJevGateway({
    apiKey,
    model,
    ...(env.JEV_API_URL ? { baseUrl: env.JEV_API_URL } : {}),
  })
  return { gateway, mode: 'live' }
}

/**
 * Run the pass over a golden file and score the captured verdicts. Returns
 * `{ skipped }` when --live has no credentials, else the metrics object that
 * was written to `outPath`. Throws on a missing file or a bad schema.
 */
export async function runForgettingEval(options = {}) {
  const goldenPath = options.goldenPath ?? DEFAULT_GOLDEN
  const outPath = options.outPath ?? DEFAULT_OUT
  const golden = loadGolden(goldenPath)
  const judge = await createGateway({
    live: options.live === true,
    answersPath: options.answersPath ?? DEFAULT_ANSWERS,
    env: options.env ?? process.env,
  })
  if (judge.skipReason) return { skipped: judge.skipReason }
  const { runForgettingPass } = await import('@3ngram/core')
  const { repo, staged } = createFixtureRepo(golden.candidates)
  const pass = await runForgettingPass(EVAL_USER, { gateway: judge.gateway, repo, now: golden.now })
  const types = memoryTypes(golden.candidates)
  const bySlice = Object.fromEntries(
    SLICES.map((s) => [s, Object.values(golden.labels).filter((l) => l.slice === s).length]),
  )
  const metrics = {
    version: 1,
    reportOnly: true,
    mode: judge.mode,
    model: staged[0]?.model ?? null,
    golden: { memories: types.size, labels: Object.keys(golden.labels).length, bySlice },
    pass,
    verdicts: {
      total: staged.length,
      proposed: staged.filter(isProposed).length,
      dismissed: staged.filter((v) => v.action !== 'keep' && v.dismissed === true).length,
      keep: staged.filter((v) => v.action === 'keep').length,
    },
    splits: {
      all: scoreLabels(staged, golden.labels, types),
      ...Object.fromEntries(
        SPLITS.map((s) => [s, scoreLabels(staged, pickSplit(golden.labels, s), types)]),
      ),
    },
    thresholds: thresholdSweep(staged, golden.labels),
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(metrics, null, 2)}\n`)
  return metrics
}

const cell = (p) =>
  p.precision === null ? '-' : `${p.precision.toFixed(3)} (${p.correct}/${p.proposed})`
const col = (s, w) => String(s).padEnd(w)

/** The compact table the CLI prints. Ids, counts and scores only. */
export function formatReport(m) {
  const lines = [
    `forgetting eval (report-only, not gated): mode ${m.mode}, model ${m.model ?? 'n/a'}`,
    `golden: ${m.golden.memories} memories, ${m.golden.labels} labels (${Object.entries(
      m.golden.bySlice,
    )
      .map(([s, n]) => `${s} ${n}`)
      .join(', ')})`,
    `pass: items ${m.pass.items}, batches ${m.pass.batches}, proposed ${m.pass.proposed}, dismissed ${m.pass.dismissed}, skipped ${m.pass.skipped}`,
    `verdicts: ${m.verdicts.total} total, ${m.verdicts.proposed} proposed, ${m.verdicts.dismissed} below threshold, ${m.verdicts.keep} keep`,
    '',
    `${col('split', 8)}${col('archive', 14)}${col('supersede', 14)}${col('combined', 14)}${col('conflict', 14)}${col('keep-rate', 12)}${col('collapses', 10)}ece`,
  ]
  for (const [name, s] of Object.entries(m.splits)) {
    const keep =
      s.keepRate.rate === null
        ? '-'
        : `${s.keepRate.rate.toFixed(2)} (${s.keepRate.kept}/${s.keepRate.stillValid})`
    lines.push(
      `${col(name, 8)}${col(cell(s.precision.archive), 14)}${col(cell(s.precision.supersede), 14)}${col(cell(s.precision.combined), 14)}${col(cell(s.precision.conflict), 14)}${col(keep, 12)}${col(s.falseCollapses.count, 10)}${s.ece.value ?? '-'}`,
    )
  }
  lines.push('', 'by type (all):')
  for (const [type, actions] of Object.entries(m.splits.all.precision.byType)) {
    const parts = Object.entries(actions).map(([a, p]) => `${a} ${cell(p)}`)
    lines.push(`  ${col(type, 12)}${parts.join('  ')}`)
  }
  lines.push('', 'threshold sweep over labelled verdicts (precision, correct/proposals):')
  lines.push(`  ${col('t', 6)}${col('archive', 16)}${col('supersede', 16)}conflict`)
  for (const [i, row] of m.thresholds.archive.entries()) {
    const at = (a) => cell(m.thresholds[a][i])
    lines.push(
      `  ${col(row.threshold.toFixed(2), 6)}${col(at('archive'), 16)}${col(at('supersede'), 16)}${at('conflict')}`,
    )
  }
  return lines.join('\n')
}

async function main(args) {
  const flag = (name, fallback) => parseFlag(args, name, fallback)
  const result = await runForgettingEval({
    goldenPath: flag('golden', DEFAULT_GOLDEN),
    answersPath: flag('answers', DEFAULT_ANSWERS),
    outPath: flag('out', DEFAULT_OUT),
    live: args.includes('--live'),
  })
  if (result.skipped) {
    process.stdout.write(`forgetting eval --live skipped: ${result.skipped} (exit 0)\n`)
    return
  }
  process.stdout.write(`${formatReport(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`forgetting eval error: ${error.message}\n`)
    process.exit(1)
  })
}
