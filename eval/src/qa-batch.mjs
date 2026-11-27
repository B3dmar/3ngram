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
// `collect` is safe to repeat: while a batch runs it reports the status and
// exits 0; once the reader batch completes it submits the judge batch; once
// that completes it scores and writes the metrics. The state file holds ids,
// models, prices and counts only, so it can travel between CI jobs. Batch
// files hold dataset text and model answers (hard rule 6): they stay at
// OpenAI, are never printed, and are deleted as soon as they are read.
//
// ADVISORY ONLY: never a gate. Needs LLM_GATEWAY_API_KEY (and optionally
// LLM_GATEWAY_URL); without it, it refuses rather than skipping, since a run
// is always started on purpose.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { ensureDataset, readJsonArray } from './download.mjs'
import { parseFlag, parsePathFlag } from './lib.mjs'
import { createBatchClient, FINAL_STATUSES } from './openai-batch.mjs'
import { judgeLabel, judgeRequest, qaScores, readerRequest } from './qa.mjs'

/** Upper bound in USD: request characters bound the tokens (ASCII prompts), plus max_tokens out. */
export function costBound(requests, { usdIn, usdOut }) {
  let inChars = 0
  let outTokens = 0
  for (const { body } of requests) {
    inChars += body.messages.reduce((sum, m) => sum + m.content.length, 0)
    outTokens += body.max_tokens
  }
  return +((inChars * usdIn + outTokens * usdOut) / 1e6).toFixed(4)
}

function guard(requests, prices, maxUsd, label) {
  const bound = costBound(requests, prices)
  if (bound > maxUsd) throw new Error(`${label}: cost bound $${bound} exceeds --max-usd ${maxUsd}`)
  return bound
}

const usd = (usage, { usdIn, usdOut }) =>
  (usage.prompt_tokens * usdIn + usage.completion_tokens * usdOut) / 1e6

/** Sum token usage over parsed Batch results. */
function usageOf(results) {
  const usage = { prompt_tokens: 0, completion_tokens: 0 }
  for (const result of results.values()) {
    usage.prompt_tokens += result.usage?.prompt_tokens ?? 0
    usage.completion_tokens += result.usage?.completion_tokens ?? 0
  }
  return usage
}

const errorCount = (results) => [...results.values()].filter((r) => r.error !== undefined).length

/** Fetch a finished batch's output (and errors), then delete its files at OpenAI. */
async function drain(client, batch, inputFileId, parse) {
  const output = batch.output_file_id
    ? parse(await client.content(batch.output_file_id))
    : new Map()
  const errors = batch.error_file_id ? parse(await client.content(batch.error_file_id)) : new Map()
  for (const id of [inputFileId, batch.output_file_id, batch.error_file_id]) {
    if (id) await client.remove(id)
  }
  return new Map([...errors, ...output])
}

/** Submit the reader batch. Returns the new state (ids and numbers only). */
export async function submitRun(options, { client, loadEntries }) {
  if (!options.reader || !options.judge) throw new Error('--reader and --judge name the models')
  const { dataset, sha256, entries } = await loadEntries(options)
  const chosen = options.limit ? entries.slice(0, options.limit) : entries
  const requests = chosen.map((entry) =>
    readerRequest(entry, { model: options.reader, cot: options.cot }),
  )
  const bound = guard(requests, options.prices, options.maxUsd, 'reader')
  const inputFileId = await client.upload(requests)
  const batch = await client.create(inputFileId, { harness: 'longmemeval-qa', stage: 'reader' })
  return {
    stage: 'reader',
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
    reader_batch: batch.id,
    reader_input_file: inputFileId,
  }
}

/**
 * Advance a run one step. Returns { state, status, metrics? }: `pending` while
 * a batch runs, `judging` after the judge batch is submitted, `done` with the
 * metrics once the judge batch is scored.
 */
export async function collectRun(state, { client, loadEntries, parse }) {
  const batchId = state.stage === 'reader' ? state.reader_batch : state.judge_batch
  const batch = await client.get(batchId)
  if (!FINAL_STATUSES.includes(batch.status)) {
    return {
      state,
      status: 'pending',
      batch_status: batch.status,
      request_counts: batch.request_counts,
    }
  }
  if (batch.status !== 'completed')
    throw new Error(`${state.stage} batch ${batchId} ended ${batch.status}`)
  const { entries } = await loadEntries({ dataset: state.dataset, sha256: state.sha256 })
  const wanted = new Set(state.question_ids)
  const chosen = entries.filter((e) => wanted.has(e.question_id))

  if (state.stage === 'reader') {
    const answers = await drain(client, batch, state.reader_input_file, parse)
    const answered = chosen.filter((e) => answers.get(e.question_id)?.content !== undefined)
    const requests = answered.map((e) =>
      judgeRequest(e, answers.get(e.question_id).content, { model: state.judge }),
    )
    const readerUsage = usageOf(answers)
    // The judge's budget is what the reader actually left, not its loose bound.
    const left = state.max_usd - usd(readerUsage, state.prices)
    const bound = guard(requests, state.judge_prices, left, 'judge')
    const inputFileId = await client.upload(requests)
    const judgeBatch = await client.create(inputFileId, {
      harness: 'longmemeval-qa',
      stage: 'judge',
    })
    const next = {
      ...state,
      stage: 'judge',
      reader_usage: readerUsage,
      reader_errors: chosen.length - answered.length,
      judge_cost_bound_usd: bound,
      judge_batch: judgeBatch.id,
      judge_input_file: inputFileId,
    }
    return { state: next, status: 'judging' }
  }

  const verdicts = await drain(client, batch, state.judge_input_file, parse)
  // A question without an answer or a verdict counts as wrong, never as skipped.
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
    batches: { reader: state.reader_batch, judge: state.judge_batch },
  }
  return { state: { ...state, stage: 'done' }, status: 'done', metrics }
}

/** The pinned dataset as raw upstream entries, refused if its hash moved since submit. */
async function loadPinned({ dataset, sha256 }) {
  const file = await ensureDataset({ variant: dataset })
  if (sha256 && file.sha256 !== sha256) throw new Error(`dataset ${dataset} changed since submit`)
  return { dataset, sha256: file.sha256, entries: [...readJsonArray(file.path)] }
}

async function main(args) {
  const [command] = args
  const statePath = parsePathFlag(args, 'state')
  if (!statePath || !['submit', 'collect'].includes(command)) {
    throw new Error('usage: qa-batch.mjs submit|collect --state <file> (see the file header)')
  }
  const { parseBatchOutput } = await import('./qa.mjs')
  const client = createBatchClient({
    baseUrl: process.env.LLM_GATEWAY_URL,
    apiKey: process.env.LLM_GATEWAY_API_KEY,
  })
  const deps = { client, loadEntries: loadPinned, parse: parseBatchOutput }
  const number = (name) => {
    const value = Number(parseFlag(args, name, ''))
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} needs a positive number`)
    return value
  }
  if (command === 'submit') {
    const state = await submitRun(
      {
        dataset: parseFlag(args, 'dataset', 'oracle'),
        reader: parseFlag(args, 'reader', ''),
        judge: parseFlag(args, 'judge', ''),
        cot: args.includes('--cot'),
        limit: args.includes('--limit') ? number('limit') : undefined,
        prices: { usdIn: number('usd-in'), usdOut: number('usd-out') },
        judgePrices: args.includes('--judge-usd-in')
          ? { usdIn: number('judge-usd-in'), usdOut: number('judge-usd-out') }
          : undefined,
        maxUsd: number('max-usd'),
      },
      deps,
    )
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
    return {
      status: 'submitted',
      reader_batch: state.reader_batch,
      cost_bound_usd: state.reader_cost_bound_usd,
    }
  }
  const result = await collectRun(JSON.parse(readFileSync(statePath, 'utf8')), deps)
  writeFileSync(statePath, `${JSON.stringify(result.state, null, 2)}\n`)
  const outPath = parsePathFlag(args, 'out')
  if (result.metrics && outPath)
    writeFileSync(outPath, `${JSON.stringify(result.metrics, null, 2)}\n`)
  return { ...result, state: undefined }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((summary) => process.stdout.write(`${JSON.stringify(summary)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`)
      process.exit(2)
    })
}
