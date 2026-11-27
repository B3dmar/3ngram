// SPDX-License-Identifier: Apache-2.0
// LongMemEval QA runs through the OpenAI Batch API (#535), as two batches:
// the reader answers every question, then the judge grades every answer.
//
//   node eval/src/qa-batch.mjs submit --state <file> --reader <model> --judge <model>
//        [--cot] [--dataset oracle|s] [--limit <n>]
//        --usd-in <per 1M> --usd-out <per 1M> --max-usd <cap>
//        [--judge-usd-in <per 1M> --judge-usd-out <per 1M>]  (default: the reader's)
//   node eval/src/qa-batch.mjs collect --state <file> [--out <metrics.json>]
//   node eval/src/qa-batch.mjs cleanup --state <file>
//
// Every run has a run id. Each upload is named lme-qa-<run id>-<stage>.jsonl
// and each batch carries { run_id, stage } in its metadata, so anything the
// run created can be found by listing, every page, even when the response that
// carried its id was lost. The state is saved at `<stage>-start` before a
// stage uploads anything, after the upload, and after the batch exists; a
// resume adopts the named upload and the tagged batch before creating either,
// so nothing is paid for twice. `collect` is safe to repeat: it reports
// `pending` while a batch runs, starts the judge after the reader, scores
// after the judge, and a finished run returns its metrics again. Batch files
// hold dataset text and model answers (hard rule 6): they are never printed;
// once the state no longer needs them they are queued in `pending_deletes` and
// deleted after the state is saved. `cleanup` cancels the run's running
// batches and deletes every file it can find for the run id.
//
// ADVISORY ONLY: never a gate. Needs LLM_GATEWAY_API_KEY (and optionally
// LLM_GATEWAY_URL); without it, it refuses rather than skipping, since a run
// is always started on purpose.
import { randomUUID } from 'node:crypto'
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
const uniqueIds = (ids) => [...new Set(ids.filter(Boolean))]
const uploadName = (state, stage) => `lme-qa-${state.run_id}-${stage}.jsonl`
const readerFiles = (state) =>
  uniqueIds([state.reader_input_file, state.reader_output_file, state.reader_error_file])

/** Save the state; a failure leaves an earlier save on disk, which a resume or cleanup can use. */
async function persist(save, state) {
  try {
    await save(state)
  } catch {
    throw new ContentFreeError(
      `the state file could not be saved; resume run ${state.run_id} with collect, or remove it with cleanup`,
    )
  }
  return state
}

/**
 * Upload a stage's input (or adopt the run's earlier upload of it), save its
 * id, then create the stage's batch (or adopt the one already tagged for it)
 * and save that id. The caller has saved `<stage>-start` already.
 */
async function startStage({ client, save }, state, stage, buildRequests) {
  let started = state
  if (!started[`${stage}_input_file`]) {
    const [earlier, ...extra] = await client.filesNamed(uploadName(state, stage))
    const inputFileId =
      earlier?.id ?? (await client.upload(await buildRequests(), uploadName(state, stage)))
    const pending = uniqueIds([...(state.pending_deletes ?? []), ...extra.map((f) => f.id)])
    started = await persist(save, {
      ...state,
      [`${stage}_input_file`]: inputFileId,
      pending_deletes: pending,
    })
  }
  const [tagged] = await client.batchesTagged({ run_id: state.run_id, stage })
  const batch =
    tagged ??
    (await client.create(started[`${stage}_input_file`], {
      harness: 'longmemeval-qa',
      run_id: state.run_id,
      stage,
    }))
  return persist(save, { ...started, stage, [`${stage}_batch`]: batch.id })
}

const failed = (state, failure, cleanup) => ({
  state: { ...state, stage: 'failed', failure, pending_deletes: uniqueIds(cleanup) },
  status: 'failed',
})

/** OpenAI's Batch queue-limit diagnostic, matched from its start; only its number is kept. */
const QUEUE_LIMIT =
  /^Enqueued token limit reached for [\w.:-]{1,80} in organization [\w-]{1,80}\. Limit: ([\d,]{1,20}) enqueued tokens\./

/** Why a batch failed, content-free: error codes with counts, and the queue limit if hit. */
export function batchFailure(batch) {
  const errors = batch.errors?.data ?? []
  const counts = new Map()
  for (const { code } of errors) {
    const safe = typeof code === 'string' && /^[a-z0-9_.-]{1,64}$/.test(code) ? code : 'other'
    counts.set(safe, (counts.get(safe) ?? 0) + 1)
  }
  const parts = [...counts].map(([code, n]) => (n > 1 ? `${code} x${n}` : code))
  // A number anywhere else in a message could come from a request.
  const limit = errors
    .filter((e) => e.code === 'token_limit_exceeded' && typeof e.message === 'string')
    .map((e) => QUEUE_LIMIT.exec(e.message)?.[1])
    .find(Boolean)
  if (limit) parts.push(`limit ${limit} enqueued tokens`)
  return parts.length > 0 ? ` (${parts.join('; ')})` : ''
}

/** A finished batch's results, errors first so an output line wins. Reads only, deletes nothing. */
async function readResults(client, outputFileId, errorFileId, parse) {
  const read = async (fileId) => (fileId ? parse(await client.content(fileId)) : new Map())
  const errors = await read(errorFileId)
  const output = await read(outputFileId)
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

/** The run's questions, from the pinned dataset. */
async function chosenEntries(state, { loadEntries }) {
  const { entries } = await loadEntries({ dataset: state.dataset, sha256: state.sha256 })
  const wanted = new Set(state.question_ids)
  return entries.filter((e) => wanted.has(e.question_id))
}

const readerRequests = (chosen, state) =>
  chosen.map((entry) => readerRequest(entry, { model: state.reader, cot: state.reading === 'cot' }))

/** Submit the reader batch, saving the state before and after each paid step. */
export async function submitRun(options, deps) {
  if (!options.reader || !options.judge) {
    throw new ContentFreeError('--reader and --judge name the models')
  }
  const { dataset, sha256, entries } = await deps.loadEntries(options)
  const chosen = options.limit ? entries.slice(0, options.limit) : entries
  const plan = { reader: options.reader, reading: options.cot ? 'cot' : 'direct' }
  const requests = readerRequests(chosen, plan)
  const bound = guard(requests, options.prices, options.maxUsd, 'reader')
  const starting = {
    stage: 'reader-start',
    run_id: options.runId ?? randomUUID(),
    dataset,
    sha256,
    question_ids: chosen.map((e) => e.question_id),
    ...plan,
    judge: options.judge,
    prices: options.prices,
    judge_prices: options.judgePrices ?? options.prices,
    max_usd: options.maxUsd,
    reader_cost_bound_usd: bound,
    pending_deletes: [],
  }
  // Saved before anything is uploaded: an unwritable state file stops the run unpaid.
  await persist(deps.save, starting)
  return startStage(deps, starting, 'reader', async () => requests)
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
    run_id: state.run_id,
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
  const done = { ...state, stage: 'done', metrics, pending_deletes: uniqueIds(cleanup) }
  return { state: done, status: 'done', metrics }
}

/** The judge requests for every answered question. */
function judgeRequests(chosen, answers, state) {
  return chosen
    .filter((e) => answers.get(e.question_id)?.content !== undefined)
    .map((e) => judgeRequest(e, answers.get(e.question_id).content, { model: state.judge }))
}

/** Start the judge from a saved `judge-start`; the reader files go once the judge batch exists. */
async function startJudge(deps, starting, requests) {
  const judging = await startStage(deps, starting, 'judge', requests)
  const queued = {
    ...judging,
    pending_deletes: uniqueIds([...judging.pending_deletes, ...readerFiles(judging)]),
  }
  return { state: queued, status: 'judging' }
}

/** The reader batch is done: start the judge batch, or score now if nothing was answered. */
async function afterReader(state, batch, deps) {
  const results = await readResults(
    deps.client,
    batch.output_file_id,
    batch.error_file_id,
    deps.parse,
  )
  const chosen = await chosenEntries(state, deps)
  const requests = judgeRequests(chosen, results, state)
  const read = {
    ...state,
    reader_output_file: batch.output_file_id ?? null,
    reader_error_file: batch.error_file_id ?? null,
    reader_usage: usageOf(results),
    reader_errors: chosen.length - requests.length,
  }
  if (requests.length === 0) {
    return finish(read, chosen, new Map(), [...(read.pending_deletes ?? []), ...readerFiles(read)])
  }
  // The judge's budget is what the reader actually spent, not its loose bound.
  const left = state.max_usd - usd(read.reader_usage, state.prices)
  let bound
  try {
    bound = guard(requests, state.judge_prices, left, 'judge')
  } catch (error) {
    if (!(error instanceof ContentFreeError)) throw error
    return failed(read, error.message, [...(read.pending_deletes ?? []), ...readerFiles(read)])
  }
  const starting = await persist(deps.save, {
    ...read,
    stage: 'judge-start',
    judge_cost_bound_usd: bound,
  })
  return startJudge(deps, starting, async () => requests)
}

/** Resume an interrupted start: adopt or redo its upload and batch from saved ids only. */
async function resumeStart(state, deps) {
  const chosen = await chosenEntries(state, deps)
  if (state.stage === 'reader-start') {
    const reader = await startStage(deps, state, 'reader', async () =>
      readerRequests(chosen, state),
    )
    return { state: reader, status: 'started' }
  }
  const rebuild = async () => {
    const answers = await readResults(
      deps.client,
      state.reader_output_file,
      state.reader_error_file,
      deps.parse,
    )
    return judgeRequests(chosen, answers, state)
  }
  return startJudge(deps, state, rebuild)
}

/**
 * Advance a run one step. Returns { state, status, metrics? }: `pending` while
 * a batch runs, `started` once an interrupted reader start is completed,
 * `judging` once the judge batch exists, `done` with the metrics, or `failed`
 * with the batch's files queued for deletion.
 */
export async function collectRun(state, deps) {
  const { client, parse = parseBatchOutput } = deps
  const full = { ...deps, parse }
  if (state.stage === 'done') return { state, status: 'done', metrics: state.metrics }
  if (state.stage === 'failed' || state.stage === 'cleaned') return { state, status: state.stage }
  if (state.stage.endsWith('-start')) return resumeStart(state, full)
  const reading = state.stage === 'reader'
  const batchId = reading ? state.reader_batch : state.judge_batch
  const batch = await client.get(batchId)
  if (!FINAL_STATUSES.includes(batch.status)) {
    return {
      state,
      status: 'pending',
      batch_status: batch.status,
      request_counts: batch.request_counts,
    }
  }
  const inputFileId = reading ? state.reader_input_file : state.judge_input_file
  const batchFiles = [inputFileId, batch.output_file_id, batch.error_file_id]
  const cleanup = [...(state.pending_deletes ?? []), ...batchFiles]
  if (batch.status !== 'completed') {
    const leftover = reading ? cleanup : [...cleanup, ...readerFiles(state)]
    const why = batchFailure(batch)
    return failed(state, `${state.stage} batch ${batchId} ended ${batch.status}${why}`, leftover)
  }
  if (reading) return afterReader(state, batch, full)
  const verdicts = await readResults(client, batch.output_file_id, batch.error_file_id, parse)
  return finish(state, await chosenEntries(state, full), verdicts, [
    ...cleanup,
    ...readerFiles(state),
  ])
}

/**
 * Remove everything the run created: cancel its running batches, then queue
 * and delete every file named for the run or attached to its batches. A
 * cancelled batch can still write files while it winds down; run it again.
 */
export async function cleanupRun(state, { client }) {
  const batches = await client.batchesTagged({ run_id: state.run_id })
  for (const batch of batches) {
    if (!FINAL_STATUSES.includes(batch.status) && batch.status !== 'cancelling') {
      await client.cancel(batch.id).catch(() => undefined)
    }
  }
  const named = await client.filesNamed(`lme-qa-${state.run_id}-`)
  const attached = batches.flatMap((b) => [b.input_file_id, b.output_file_id, b.error_file_id])
  const queued = uniqueIds([
    ...(state.pending_deletes ?? []),
    ...named.map((f) => f.id),
    ...attached,
    ...readerFiles(state),
    state.judge_input_file,
  ])
  const stage = state.stage === 'done' ? 'done' : 'cleaned'
  return sweep(client, { ...state, stage, pending_deletes: queued })
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
  if (has(args, 'judge-usd-in') !== has(args, 'judge-usd-out')) {
    throw new ContentFreeError('--judge-usd-in and --judge-usd-out go together')
  }
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

/** Parse and check every argument before anything is paid for. */
function parseArgs(args) {
  const [command] = args
  let statePath
  let outPath
  try {
    statePath = parsePathFlag(args, 'state')
    outPath = parsePathFlag(args, 'out')
  } catch (error) {
    throw new ContentFreeError(error.message) // "--out needs a path": our own words
  }
  if (!statePath || !['submit', 'collect', 'cleanup'].includes(command)) {
    throw new ContentFreeError(
      'usage: qa-batch.mjs submit|collect|cleanup --state <file> (see the file header)',
    )
  }
  if (command === 'submit' && existsSync(statePath)) {
    throw new ContentFreeError('the state file already exists: a new run needs a new one')
  }
  const options = command === 'submit' ? submitOptions(args) : undefined
  return { command, statePath, outPath, options }
}

async function main(args) {
  const { command, statePath, outPath, options } = parseArgs(args)
  const client = createBatchClient({
    baseUrl: process.env.LLM_GATEWAY_URL,
    apiKey: process.env.LLM_GATEWAY_API_KEY,
  })
  const save = (state) => writeState(statePath, state)
  const deps = { client, loadEntries: loadPinned, save }
  if (command === 'submit') {
    const state = await submitRun(options, deps)
    return { status: 'submitted', run_id: state.run_id, reader_batch: state.reader_batch }
  }
  const loaded = JSON.parse(readFileSync(statePath, 'utf8'))
  save(loaded) // the state file is writable before any paid step
  if (command === 'cleanup') {
    const cleaned = await cleanupRun(loaded, deps)
    save(cleaned)
    return {
      status: cleaned.stage,
      run_id: cleaned.run_id,
      pending_deletes: cleaned.pending_deletes.length,
    }
  }
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
