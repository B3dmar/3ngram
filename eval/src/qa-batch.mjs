// SPDX-License-Identifier: Apache-2.0
// LongMemEval QA runs through the OpenAI Batch API (#535), as two batches:
// the reader answers every question, then the judge grades every answer.
//
//   node eval/src/qa-batch.mjs submit --state <file> --reader <model> --judge <model>
//        [--cot] [--dataset oracle|s] [--limit <n>]
//        --usd-in <per 1M> --usd-out <per 1M> --max-usd <cap>
//        [--judge-usd-in <per 1M> --judge-usd-out <per 1M>]  (default: the reader's)
//   node eval/src/qa-batch.mjs collect --state <file> [--out <metrics.json>]
//
// `collect` is safe to repeat. While a batch runs it reports the status and
// exits 0. The state is saved after every upload and every batch creation (a
// save that fails undoes the upload it would record), and a retry adopts a
// batch an earlier attempt created for the same input file instead of paying
// twice, so any failure can be retried. Arguments and the state file's
// location are checked before anything is paid for. A finished run keeps its
// metrics in the state and returns them again. Batch files hold dataset text
// and model answers (hard rule 6): they are never printed, and once the state
// no longer needs them they are queued in `pending_deletes` and deleted right
// after the state is saved; a deletion that fails stays queued.
//
// ADVISORY ONLY: never a gate. Needs LLM_GATEWAY_API_KEY (and optionally
// LLM_GATEWAY_URL); without it, it refuses rather than skipping, since a run
// is always started on purpose.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { ContentFreeError } from './content-free-error.mjs'
import { ensureDataset, readJsonArray } from './download.mjs'
import { parseFlag, parsePathFlag } from './lib.mjs'
import { createBatchClient, FINAL_STATUSES } from './openai-batch.mjs'
import { judgeLabel, judgeRequest, parseBatchOutput, qaScores, readerRequest } from './qa.mjs'

/** Chat Completions framing per request (role and priming tokens), set well above the real few. */
const FRAMING_TOKENS = 32

/**
 * Upper bound in USD. A byte-level BPE token covers at least one UTF-8 byte,
 * so bytes bound the prompt tokens even for non-ASCII answers in judge
 * prompts; add the framing and max_tokens out.
 */
export function costBound(requests, { usdIn, usdOut }) {
  let inTokens = 0
  let outTokens = 0
  for (const { body } of requests) {
    for (const message of body.messages) inTokens += Buffer.byteLength(message.content, 'utf8')
    inTokens += FRAMING_TOKENS
    outTokens += body.max_tokens
  }
  return (inTokens * usdIn + outTokens * usdOut) / 1e6
}

/** Refuse before anything is uploaded; the unrounded bound is what is compared. */
function guard(requests, prices, maxUsd, label) {
  const bound = costBound(requests, prices)
  if (bound > maxUsd) {
    throw new ContentFreeError(
      `${label}: cost bound $${bound.toFixed(4)} exceeds the $${maxUsd} left`,
    )
  }
  return +bound.toFixed(4)
}

const usd = (usage, { usdIn, usdOut }) =>
  (usage.prompt_tokens * usdIn + usage.completion_tokens * usdOut) / 1e6

/** Sum token usage over parsed Batch results, billed refusals and errors included. */
function usageOf(results) {
  const usage = { prompt_tokens: 0, completion_tokens: 0 }
  for (const result of results.values()) {
    usage.prompt_tokens += result.usage?.prompt_tokens ?? 0
    usage.completion_tokens += result.usage?.completion_tokens ?? 0
  }
  return usage
}

const errorCount = (results) => [...results.values()].filter((r) => r.error !== undefined).length
const batchFiles = (batch, inputFileId) =>
  [inputFileId, batch.output_file_id, batch.error_file_id].filter(Boolean)

/** Save the state; if that fails, undo the side effect it would have recorded, then stop. */
async function persist(save, state, undo) {
  try {
    await save(state)
  } catch {
    if (undo) await undo().catch(() => undefined)
    throw new ContentFreeError('the state file could not be saved; the step it records was undone')
  }
  return state
}

/** Create (or adopt) the batch for a stage's saved input file, then save its id. */
async function createStage(client, save, state, stage) {
  const inputFileId = state[`${stage}_input_file`]
  const batch =
    (await client.findByInput(inputFileId)) ??
    (await client.create(inputFileId, { harness: 'longmemeval-qa', stage }))
  // No undo: the `-start` state already holds the input file, so a retry adopts this batch.
  return persist(save, { ...state, stage, [`${stage}_batch`]: batch.id })
}

/** Upload a stage's requests, save the file id, then create its batch. */
async function startStage(client, save, state, requests, stage) {
  const inputFileId = await client.upload(requests)
  const starting = { ...state, stage: `${stage}-start`, [`${stage}_input_file`]: inputFileId }
  await persist(save, starting, () => client.remove(inputFileId))
  return createStage(client, save, starting, stage)
}

const failed = (state, failure, cleanup) => ({
  state: { ...state, stage: 'failed', failure, pending_deletes: cleanup },
  status: 'failed',
})

/** A finished batch's results, errors first so an output line wins. Reads only, deletes nothing. */
async function readResults(client, batch, parse) {
  const read = async (fileId) => (fileId ? parse(await client.content(fileId)) : new Map())
  const errors = await read(batch.error_file_id)
  const output = await read(batch.output_file_id)
  return new Map([...errors, ...output])
}

/** Delete every queued file, each attempted; failures stay queued. */
export async function sweep(client, state) {
  const left = []
  for (const fileId of state.pending_deletes ?? []) {
    try {
      await client.remove(fileId)
    } catch {
      left.push(fileId)
    }
  }
  return { ...state, pending_deletes: left }
}

/** Submit the reader batch, saving the state before and after each paid step. */
export async function submitRun(options, { client, loadEntries, save }) {
  if (!options.reader || !options.judge) {
    throw new ContentFreeError('--reader and --judge name the models')
  }
  const { dataset, sha256, entries } = await loadEntries(options)
  const chosen = options.limit ? entries.slice(0, options.limit) : entries
  const requests = chosen.map((entry) =>
    readerRequest(entry, { model: options.reader, cot: options.cot }),
  )
  const bound = guard(requests, options.prices, options.maxUsd, 'reader')
  const prepared = {
    stage: 'reader-prepare',
    dataset,
    sha256,
    question_ids: chosen.map((e) => e.question_id),
    reader: options.reader,
    judge: options.judge,
    reading: options.cot ? 'cot' : 'direct',
    prices: options.prices,
    judge_prices: options.judgePrices ?? options.prices,
    max_usd: options.maxUsd,
    reader_cost_bound_usd: bound,
    pending_deletes: [],
  }
  // Saved before anything is uploaded: an unwritable state file stops the run unpaid.
  await persist(save, prepared)
  return startStage(client, save, prepared, requests, 'reader')
}

/** Score the run: a question without an answer or a verdict counts as wrong, never as skipped. */
function finish(state, chosen, verdicts, cleanup) {
  const labels = new Map(
    chosen.map((e) => [e.question_id, judgeLabel(verdicts.get(e.question_id)?.content ?? '')]),
  )
  const judgeUsage = usageOf(verdicts)
  const costUsd = usd(state.reader_usage, state.prices) + usd(judgeUsage, state.judge_prices)
  const metrics = {
    harness: 'longmemeval-qa',
    tier: 'advisory',
    dataset: state.dataset,
    sha256: state.sha256,
    reader: state.reader,
    reading: state.reading,
    questions: chosen.length,
    reader_errors: state.reader_errors,
    judge_errors: errorCount(verdicts),
    ...qaScores(chosen, labels, { judge: state.judge }),
    usage: { reader: state.reader_usage, judge: judgeUsage },
    cost_usd: +costUsd.toFixed(4),
    batches: { reader: state.reader_batch, judge: state.judge_batch ?? null },
  }
  const done = { ...state, stage: 'done', metrics, pending_deletes: cleanup }
  return { state: done, status: 'done', metrics }
}

/** The reader batch is done: start the judge batch, or score now if nothing was answered. */
async function afterReader(state, chosen, answers, cleanup, { client, save }) {
  const answered = chosen.filter((e) => answers.get(e.question_id)?.content !== undefined)
  const readerUsage = usageOf(answers)
  const read = {
    ...state,
    reader_usage: readerUsage,
    reader_errors: chosen.length - answered.length,
  }
  if (answered.length === 0) return finish(read, chosen, new Map(), cleanup)
  const requests = answered.map((e) =>
    judgeRequest(e, answers.get(e.question_id).content, { model: state.judge }),
  )
  // The judge's budget is what the reader actually spent, not its loose bound.
  const left = state.max_usd - usd(readerUsage, state.prices)
  let bound
  try {
    bound = guard(requests, state.judge_prices, left, 'judge')
  } catch (error) {
    if (!(error instanceof ContentFreeError)) throw error
    return failed(read, error.message, cleanup) // ends the run and lets the reader files go
  }
  // The judge input carries the answers, so the reader files can go once it is saved.
  const prepared = { ...read, judge_cost_bound_usd: bound, pending_deletes: cleanup }
  const judging = await startStage(client, save, prepared, requests, 'judge')
  return { state: judging, status: 'judging' }
}

/**
 * Advance a run one step. Returns { state, status, metrics? }: `pending` while
 * a batch runs, `started` once an interrupted start is completed, `judging`
 * once the judge batch exists, `done` with the metrics, or `failed` with the
 * batch's files queued for deletion.
 */
export async function collectRun(state, deps) {
  const { client, loadEntries, save, parse = parseBatchOutput } = deps
  if (state.stage === 'done') return { state, status: 'done', metrics: state.metrics }
  if (state.stage === 'failed') return { state, status: 'failed' }
  if (state.stage === 'reader-prepare') {
    throw new ContentFreeError('submit stopped before uploading; nothing to collect')
  }
  if (state.stage.endsWith('-start')) {
    const stage = state.stage.replace('-start', '')
    return { state: await createStage(client, save, state, stage), status: 'started' }
  }
  const reading = state.stage === 'reader'
  const batchId = reading ? state.reader_batch : state.judge_batch
  const inputFileId = reading ? state.reader_input_file : state.judge_input_file
  const batch = await client.get(batchId)
  if (!FINAL_STATUSES.includes(batch.status)) {
    return {
      state,
      status: 'pending',
      batch_status: batch.status,
      request_counts: batch.request_counts,
    }
  }
  const cleanup = [...(state.pending_deletes ?? []), ...batchFiles(batch, inputFileId)]
  if (batch.status !== 'completed') {
    return failed(state, `${state.stage} batch ${batchId} ended ${batch.status}`, cleanup)
  }
  const results = await readResults(client, batch, parse)
  const { entries } = await loadEntries({ dataset: state.dataset, sha256: state.sha256 })
  const wanted = new Set(state.question_ids)
  const chosen = entries.filter((e) => wanted.has(e.question_id))
  if (reading) return afterReader(state, chosen, results, cleanup, deps)
  return finish(state, chosen, results, cleanup)
}

/** The pinned dataset as raw upstream entries, refused if its hash moved since submit. */
async function loadPinned({ dataset, sha256 }) {
  const file = await ensureDataset({ variant: dataset })
  if (sha256 && file.sha256 !== sha256) {
    throw new ContentFreeError(`dataset ${dataset} changed since submit`)
  }
  return { dataset, sha256: file.sha256, entries: [...readJsonArray(file.path)] }
}

/** A flag given as `--name` or `--name=value`. */
const has = (args, name) => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`))

function positive(args, name) {
  const value = Number(parseFlag(args, name, ''))
  if (!Number.isFinite(value) || value <= 0) {
    throw new ContentFreeError(`--${name} needs a positive number`)
  }
  return value
}

/** The submit options, both `--name value` and `--name=value` accepted. */
export function submitOptions(args) {
  return {
    dataset: parseFlag(args, 'dataset', 'oracle'),
    reader: parseFlag(args, 'reader', ''),
    judge: parseFlag(args, 'judge', ''),
    cot: args.includes('--cot'),
    limit: has(args, 'limit') ? positive(args, 'limit') : undefined,
    prices: { usdIn: positive(args, 'usd-in'), usdOut: positive(args, 'usd-out') },
    judgePrices: has(args, 'judge-usd-in')
      ? { usdIn: positive(args, 'judge-usd-in'), usdOut: positive(args, 'judge-usd-out') }
      : undefined,
    maxUsd: positive(args, 'max-usd'),
  }
}

/** Write the state atomically, so a failed write never leaves half a file. */
function writeState(path, state) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}

async function main(args) {
  const [command] = args
  // Every argument is checked before anything is paid for.
  let statePath
  let outPath
  try {
    statePath = parsePathFlag(args, 'state')
    outPath = parsePathFlag(args, 'out')
  } catch (error) {
    throw new ContentFreeError(error.message) // "--out needs a path": our own words
  }
  if (!statePath || !['submit', 'collect'].includes(command)) {
    throw new ContentFreeError(
      'usage: qa-batch.mjs submit|collect --state <file> (see the file header)',
    )
  }
  const options = command === 'submit' ? submitOptions(args) : undefined
  if (command === 'submit' && existsSync(statePath)) {
    throw new ContentFreeError('the state file already exists: a new run needs a new one')
  }
  const client = createBatchClient({
    baseUrl: process.env.LLM_GATEWAY_URL,
    apiKey: process.env.LLM_GATEWAY_API_KEY,
  })
  const save = (state) => writeState(statePath, state)
  const deps = { client, loadEntries: loadPinned, save }
  if (command === 'submit') {
    const state = await submitRun(options, deps)
    return {
      status: 'submitted',
      reader_batch: state.reader_batch,
      cost_bound_usd: state.reader_cost_bound_usd,
    }
  }
  const loaded = JSON.parse(readFileSync(statePath, 'utf8'))
  save(loaded) // the state file is writable before any paid step
  const result = await collectRun(loaded, deps)
  // Metrics are written before the state moves on, so a failed write can be collected again.
  if (result.metrics && outPath)
    writeFileSync(outPath, `${JSON.stringify(result.metrics, null, 2)}\n`)
  save(result.state)
  const swept = await sweep(client, result.state)
  save(swept)
  if (result.status === 'failed') throw new ContentFreeError(result.state.failure)
  return {
    status: result.status,
    batch_status: result.batch_status,
    pending_deletes: swept.pending_deletes.length,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((summary) => process.stdout.write(`${JSON.stringify(summary)}\n`))
    .catch((error) => {
      // Only messages this code wrote are printed; others may quote content (hard rule 6).
      const message =
        error instanceof ContentFreeError ? error.message : `${error.name}: details withheld`
      process.stderr.write(`${message}\n`)
      process.exit(2)
    })
}
