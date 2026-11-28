// SPDX-License-Identifier: Apache-2.0
// LongMemEval QA runs through the OpenAI Batch API (#535): the reader answers
// every question, then the judge grades every answer. The reader runs as one
// or more parts, one batch at a time, each under OpenAI's Batch queue limit
// on enqueued tokens per model (1,350,000 for gpt-4o at usage tier 2).
//
//   node eval/src/qa-batch.mjs submit --state <file> --reader <model> --judge <model>
//        [--cot] [--dataset oracle|s] [--limit <n>] [--part-tokens <n>]
//        --usd-in <per 1M> --usd-out <per 1M> --max-usd <cap>
//        [--judge-usd-in <per 1M> --judge-usd-out <per 1M>]  (default: the reader's)
//   node eval/src/qa-batch.mjs collect --state <file> [--out <metrics.json>]
//   node eval/src/qa-batch.mjs cleanup --state <file>
//
// Every run has a run id. Each upload is named lme-qa-<run id>-<stage>.jsonl
// (stage reader-<k> or judge) and each batch carries { run_id, stage } in its metadata, so anything the
// run created can be found by listing, every page, even when the response that
// carried its id was lost. The state is saved at `<stage>-start` before a
// stage uploads anything, after the upload, and after the batch exists; a
// resume adopts the named upload and the tagged batch before creating either,
// so nothing is paid for twice. `collect` is safe to repeat: it reports
// `pending` while a batch runs, starts the next reader part after each one,
// the judge after the last, scores
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

/** Estimated enqueued tokens one reader part may hold: under 1,350,000 with room to spare. */
const PART_TOKENS = 1_200_000

/**
 * A request's enqueued tokens, estimated high: English prompts run about four
 * UTF-8 bytes per token, three are assumed, and max_tokens is counted too. A
 * part over the real limit fails free at validation, naming the limit.
 */
export function enqueuedTokens({ body }) {
  let bytes = 0
  for (const message of body.messages) bytes += Buffer.byteLength(message.content, 'utf8')
  return Math.ceil(bytes / 3) + FRAMING_TOKENS + body.max_tokens
}

/** Split requests, in order, into [from, to) parts of at most `budget` estimated tokens. */
export function splitParts(requests, budget) {
  const parts = []
  let from = 0
  let tokens = 0
  requests.forEach((request, i) => {
    const n = enqueuedTokens(request)
    if (i > from && tokens + n > budget) {
      parts.push([from, i])
      from = i
      tokens = 0
    }
    tokens += n
  })
  if (requests.length > from) parts.push([from, requests.length])
  return parts
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
/** The current reader part's input and every finished part's output and error files. */
const readerFiles = (state) =>
  uniqueIds([
    state.reader_input_file,
    ...(state.reader_results ?? []).flatMap((r) => [r.output_file, r.error_file]),
  ])
const partName = (state) => `reader-${state.reader_part + 1}`

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
 * and save that id. `key` is `reader` or `judge`, `name` the upload's and
 * batch's stage (`reader-<k>` or `judge`). The caller saved `<key>-start`.
 */
async function startStage({ client, save }, state, key, name, buildRequests) {
  let started = state
  if (!started[`${key}_input_file`]) {
    const [earlier, ...extra] = await client.filesNamed(uploadName(state, name))
    const inputFileId =
      earlier?.id ?? (await client.upload(await buildRequests(), uploadName(state, name)))
    const pending = uniqueIds([...(state.pending_deletes ?? []), ...extra.map((f) => f.id)])
    started = await persist(save, {
      ...state,
      [`${key}_input_file`]: inputFileId,
      pending_deletes: pending,
    })
  }
  const [tagged] = await client.batchesTagged({ run_id: state.run_id, stage: name })
  const batch =
    tagged ??
    (await client.create(started[`${key}_input_file`], {
      harness: 'longmemeval-qa',
      run_id: state.run_id,
      stage: name,
    }))
  return persist(save, { ...started, stage: key, [`${key}_batch`]: batch.id })
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

/** The current part's reader requests, in question_ids order. */
function partRequests(chosen, state) {
  const byId = new Map(chosen.map((e) => [e.question_id, e]))
  const [from, to] = state.reader_parts[state.reader_part]
  return readerRequests(
    state.question_ids.slice(from, to).map((id) => byId.get(id)),
    state,
  )
}

/** Start the current reader part from a saved `reader-start`. */
const startPart = (deps, state, build) => startStage(deps, state, 'reader', partName(state), build)

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
  const parts = splitParts(requests, options.partTokens ?? PART_TOKENS)
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
    reader_parts: parts,
    reader_part: 0,
    reader_results: [],
    pending_deletes: [],
  }
  // Saved before anything is uploaded: an unwritable state file stops the run unpaid.
  await persist(deps.save, starting)
  return startPart(deps, starting, async () => requests.slice(...parts[0]))
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
    batches: { reader: state.reader_results.map((r) => r.batch), judge: state.judge_batch ?? null },
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
  const judging = await startStage(deps, starting, 'judge', 'judge', requests)
  const queued = {
    ...judging,
    pending_deletes: uniqueIds([...judging.pending_deletes, ...readerFiles(judging)]),
  }
  return { state: queued, status: 'judging' }
}

/** Every finished reader part's answers. */
async function readAnswers(client, state, parse) {
  const answers = new Map()
  for (const { output_file, error_file } of state.reader_results) {
    for (const [id, result] of await readResults(client, output_file, error_file, parse)) {
      answers.set(id, result)
    }
  }
  return answers
}

/** A reader part is done: keep its files, let its input go, then start the next part or the judge. */
async function afterPart(state, batch, deps) {
  const results = [
    ...state.reader_results,
    {
      batch: state.reader_batch,
      output_file: batch.output_file_id ?? null,
      error_file: batch.error_file_id ?? null,
    },
  ]
  const { reader_input_file: input, reader_batch: _batch, ...rest } = state
  const read = {
    ...rest,
    reader_results: results,
    pending_deletes: uniqueIds([...(state.pending_deletes ?? []), input]),
  }
  if (state.reader_part + 1 === state.reader_parts.length) return afterReader(read, deps)
  const next = await persist(deps.save, {
    ...read,
    stage: 'reader-start',
    reader_part: state.reader_part + 1,
  })
  const chosen = await chosenEntries(next, deps)
  return {
    state: await startPart(deps, next, async () => partRequests(chosen, next)),
    status: 'started',
  }
}

/** Every reader part is done: start the judge batch, or score now if nothing was answered. */
async function afterReader(state, deps) {
  const results = await readAnswers(deps.client, state, deps.parse)
  const chosen = await chosenEntries(state, deps)
  const requests = judgeRequests(chosen, results, state)
  const read = {
    ...state,
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
    const reader = await startPart(deps, state, async () => partRequests(chosen, state))
    return { state: reader, status: 'started' }
  }
  const rebuild = async () =>
    judgeRequests(chosen, await readAnswers(deps.client, state, deps.parse), state)
  return startJudge(deps, state, rebuild)
}

/**
 * Advance a run one step. Returns { state, status, metrics? }: `pending` while
 * a batch runs, `started` once a reader part's batch exists,
 * `judging` once the judge batch exists, `done` with the metrics, or `failed`
 * with the batch's files queued for deletion.
 */
export async function collectRun(state, deps) {
  const { client, parse = parseBatchOutput } = deps
  const full = { ...deps, parse }
  if (state.stage === 'done') return { state, status: 'done', metrics: state.metrics }
  if (state.stage === 'failed' || state.stage === 'cleaned') return { state, status: state.stage }
  if (!Array.isArray(state.reader_parts)) {
    // Its batch is tagged `reader`, not `reader-<k>`: resuming here could create a second one.
    throw new ContentFreeError(
      `run ${state.run_id} was started before reader parts: remove it with cleanup and submit again`,
    )
  }
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
    const name = reading ? partName(state) : 'judge'
    const why = `${name} batch ${batchId} ended ${batch.status}${batchFailure(batch)}`
    return failed(state, why, [...cleanup, ...readerFiles(state)])
  }
  if (reading) return afterPart(state, batch, full)
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
    partTokens: has(args, 'part-tokens') ? positive(args, 'part-tokens') : undefined,
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
    const parts = state.reader_parts.length
    return { status: 'submitted', run_id: state.run_id, reader_batch: state.reader_batch, parts }
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
  const { stage, reader_part: part, reader_parts: parts } = swept
  return {
    status: result.status,
    batch_status: result.batch_status,
    ...(stage === 'reader' && parts ? { part: `${part + 1}/${parts.length}` } : {}),
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
