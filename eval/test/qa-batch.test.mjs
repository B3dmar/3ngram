// SPDX-License-Identifier: Apache-2.0
// LongMemEval QA through the Batch API (#535), against a fake Batch API: no
// network, no model. Submit, poll, judge, score; run-id naming so a lost
// response, a failed save or a later page never loses or duplicates a paid
// object; cleanup by run id; ids-only state; content-free errors.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ContentFreeError } from '../src/content-free-error.mjs'
import { createBatchClient } from '../src/openai-batch.mjs'
import { parseBatchOutput } from '../src/qa.mjs'
import {
  cleanupRun,
  collectRun,
  costBound,
  submitOptions,
  submitRun,
  sweep,
} from '../src/qa-batch.mjs'

const { cases } = JSON.parse(
  readFileSync(new URL('../fixtures/qa-parity.json', import.meta.url), 'utf8'),
)
const entries = cases.map((c) => c.entry)
const loadEntries = async () => ({ dataset: 'oracle', sha256: 'abc', entries })
const PRICES = { usdIn: 1.25, usdOut: 5 }
const OPTIONS = {
  reader: 'gpt-4o-2024-08-06',
  judge: 'gpt-4o-2024-08-06',
  prices: PRICES,
  maxUsd: 5,
  runId: 'run1',
}
const SECRET = 'SECRET answer text'

/** One page of a cursor listing, newest first, as the API pages it. */
function page(items, search, size) {
  const after = new URLSearchParams(search).get('after')
  const start = after ? items.findIndex((item) => item.id === after) + 1 : 0
  const data = items.slice(start, start + size)
  return { data, has_more: start + size < items.length }
}

/** An in-memory Batch API with named files, tagged batches, paging and failure switches. */
function fakeOpenAI() {
  const files = new Map()
  const batches = new Map()
  const api = { files, batches, gets: 0, uploads: 0, creates: 0, pageSize: 100 }
  Object.assign(api, { uploadMode: 'ok', createMode: 'ok', nonJsonGet: false, hang: false })
  let next = 0
  const reply = (status, body) => new Response(JSON.stringify(body), { status })
  const newest = (map) => [...map.values()].reverse()
  api.fetch = async (url, init) => {
    if (api.hang) {
      return new Promise((_, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason)),
      )
    }
    const { pathname, search } = new URL(url)
    const path = pathname.replace(/^\/v1/, '')
    const id = path.split('/')[2]
    if (init.method === 'POST' && path === '/files') {
      api.uploads++
      const file = init.body.get('file')
      const record = { id: `file-${++next}`, filename: file.name, text: await file.text() }
      files.set(record.id, record)
      // 'lost': the file is stored, but the response never reaches the caller.
      return api.uploadMode === 'lost'
        ? reply(502, { error: SECRET })
        : reply(200, { id: record.id })
    }
    if (init.method === 'GET' && path === '/files') {
      const listed = newest(files).map(({ id: fileId, filename }) => ({ id: fileId, filename }))
      return reply(200, page(listed, search, api.pageSize))
    }
    if (init.method === 'POST' && path === '/batches') {
      const { input_file_id, metadata } = JSON.parse(init.body)
      if (api.createMode === 'fail') return reply(500, { error: SECRET })
      api.creates++
      const batch = { id: `batch-${++next}`, status: 'in_progress', input_file_id, metadata }
      batches.set(batch.id, batch)
      return api.createMode === 'lost' ? reply(502, { error: SECRET }) : reply(200, batch)
    }
    if (init.method === 'GET' && path === '/batches') {
      return reply(200, page(newest(batches), search, api.pageSize))
    }
    if (init.method === 'POST' && path.endsWith('/cancel') && batches.has(id)) {
      batches.get(id).status = 'cancelled'
      return reply(200, batches.get(id))
    }
    if (init.method === 'GET' && batches.has(id)) {
      api.gets++
      return api.nonJsonGet ? new Response(`not json ${SECRET}`) : reply(200, batches.get(id))
    }
    if (init.method === 'GET' && path.endsWith('/content') && files.has(id)) {
      return new Response(files.get(id).text)
    }
    if (init.method === 'DELETE')
      return files.delete(id) ? reply(200, { deleted: true }) : reply(404, {})
    return reply(404, { error: SECRET })
  }
  /** Finish a batch, answering each request line with `answer(line)` (null for a refusal). */
  api.complete = (batchId, answer) => {
    const batch = batches.get(batchId)
    const lines = files
      .get(batch.input_file_id)
      .text.trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const out = lines.map((line) => {
      const content = answer(line)
      const message = content === null ? { content: null, refusal: 'no' } : { content }
      return JSON.stringify({
        custom_id: line.custom_id,
        response: {
          status_code: 200,
          body: { choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 5 } },
        },
        error: null,
      })
    })
    const output = { id: `file-${++next}`, filename: 'batch_output.jsonl', text: out.join('\n') }
    files.set(output.id, output)
    Object.assign(batch, { status: 'completed', output_file_id: output.id })
  }
  return api
}

/** A state file in memory; `failAt` makes that save (1-based) throw, as a full disk would. */
function store(failAt) {
  const saves = []
  return {
    saves,
    last: () => saves.filter(Boolean).at(-1),
    save: (state) => {
      if (saves.length + 1 === failAt) {
        saves.push(null)
        throw new Error('disk full')
      }
      saves.push(structuredClone(state))
    },
  }
}

function setup({ failAt, timeoutMs } = {}) {
  const api = fakeOpenAI()
  const client = createBatchClient({
    baseUrl: 'https://api.test/v1/',
    apiKey: 'k',
    fetch: api.fetch,
    timeoutMs,
  })
  const disk = store(failAt)
  return { api, disk, deps: { client, loadEntries, parse: parseBatchOutput, save: disk.save } }
}

/** collect, then save-and-sweep, as the CLI does. */
async function step(state, deps) {
  const result = await collectRun(state, deps)
  return { ...result, state: await sweep(deps.client, result.state) }
}

test('a run submits the reader, then the judge, then scores; every batch file is deleted (#535)', async () => {
  const { api, disk, deps } = setup()
  let state = await submitRun(OPTIONS, deps)
  assert.deepEqual(
    disk.saves.map((s) => [s.stage, Boolean(s.reader_input_file), Boolean(s.reader_batch)]),
    [
      ['reader-start', false, false],
      ['reader-start', true, false],
      ['reader', true, true],
    ],
    'saved before the upload, after it, and after the batch exists',
  )
  assert.equal(api.files.get(state.reader_input_file).filename, 'lme-qa-run1-reader.jsonl')
  assert.deepEqual(api.batches.get(state.reader_batch).metadata, {
    harness: 'longmemeval-qa',
    run_id: 'run1',
    stage: 'reader',
  })
  assert.equal((await step(state, deps)).status, 'pending', 'still running')

  api.complete(state.reader_batch, (line) => `answer for ${line.custom_id}`)
  let result = await step(state, deps)
  assert.equal(result.status, 'judging')
  state = result.state
  assert.deepEqual(state.reader_usage, { prompt_tokens: 700, completion_tokens: 35 })

  api.complete(state.judge_batch, (line) => (line.custom_id === 'q-order' ? 'No.' : 'Yes'))
  result = await step(state, deps)
  assert.equal(result.status, 'done')
  const { metrics } = result
  assert.equal(metrics.upstream_judge, true)
  assert.equal(metrics.overall_accuracy, +(6 / 7).toFixed(4))
  assert.equal(metrics.cost_usd, +((1400 * 1.25 + 70 * 5) / 1e6).toFixed(4))
  assert.equal(api.files.size, 0, 'inputs and outputs deleted at OpenAI')
  for (const value of [result.state, metrics, ...disk.saves]) {
    const text = JSON.stringify(value)
    assert.equal(text.includes('Synthetic question'), false)
    assert.equal(text.includes('answer for'), false)
  }
  // Done is final: a repeat returns the same metrics without touching the API.
  const gets = api.gets
  assert.deepEqual((await step(result.state, deps)).metrics, metrics)
  assert.equal(api.gets, gets)
})

test('an unwritable state file stops the run before anything is uploaded', async () => {
  const { api, deps } = setup({ failAt: 1 })
  await assert.rejects(submitRun(OPTIONS, deps), /state file could not be saved/)
  assert.equal(api.files.size, 0)
})

test('a save that fails after the upload: the resume adopts the named upload, no second one', async () => {
  const { api, disk, deps } = setup({ failAt: 2 })
  await assert.rejects(
    submitRun(OPTIONS, deps),
    /resume run run1 with collect, or remove it with cleanup/,
  )
  const saved = disk.last()
  assert.equal(saved.stage, 'reader-start')
  assert.equal(saved.reader_input_file, undefined, 'the id never reached the state')
  const result = await collectRun(saved, deps)
  assert.equal(result.status, 'started')
  assert.equal(api.uploads, 1, 'adopted by name, not uploaded again')
  assert.equal(api.creates, 1)
})

test('a lost upload response: the resume finds the upload by name', async () => {
  const { api, disk, deps } = setup()
  api.uploadMode = 'lost'
  await assert.rejects(submitRun(OPTIONS, deps), /POST \/files failed with status 502/)
  api.uploadMode = 'ok'
  const result = await collectRun(disk.last(), deps)
  assert.equal(result.status, 'started')
  assert.equal(api.uploads, 1)
  assert.equal(result.state.reader_input_file, [...api.files.keys()][0])
})

test('a lost create response: the resume adopts the tagged batch, found on a later page', async () => {
  const { api, disk, deps } = setup()
  api.pageSize = 1
  api.createMode = 'lost'
  await assert.rejects(submitRun(OPTIONS, deps), /failed with status 502/)
  // An unrelated, newer batch puts ours on page two.
  api.batches.set('batch-other', { id: 'batch-other', status: 'in_progress', metadata: {} })
  api.createMode = 'ok'
  const result = await collectRun(disk.last(), deps)
  assert.equal(result.status, 'started')
  assert.equal(api.creates, 1, 'adopted, never created twice')
  assert.equal(api.batches.get(result.state.reader_batch).metadata.run_id, 'run1')
})

test('an interrupted judge start resumes from the saved reader output', async () => {
  const { api, disk, deps } = setup()
  const state = await submitRun(OPTIONS, deps)
  api.complete(state.reader_batch, () => 'an answer')
  api.uploadMode = 'lost'
  await assert.rejects(collectRun(state, deps), /POST \/files failed with status 502/)
  const saved = disk.last()
  assert.equal(saved.stage, 'judge-start')
  api.uploadMode = 'ok'
  const result = await step(saved, deps)
  assert.equal(result.status, 'judging')
  assert.equal(api.uploads, 2, 'reader and judge, each once')
  const left = [...api.files.values()].map((f) => f.filename)
  assert.deepEqual(left, ['lme-qa-run1-judge.jsonl'], 'reader files deleted once the judge exists')
})

test('cleanup cancels the run and deletes everything named or attached to it', async () => {
  const { api, deps } = setup()
  const state = await submitRun(OPTIONS, deps)
  api.uploadMode = 'lost'
  const unrelated = { id: 'file-keep', filename: 'other.jsonl', text: '' }
  api.files.set(unrelated.id, unrelated)
  const cleaned = await cleanupRun(state, deps)
  assert.equal(cleaned.stage, 'cleaned')
  assert.equal(api.batches.get(state.reader_batch).status, 'cancelled')
  assert.deepEqual([...api.files.keys()], ['file-keep'], 'only the unrelated file is left')
})

test('a judge budget refusal ends the run as failed and lets the reader files go', async () => {
  const { api, deps } = setup()
  const state = await submitRun({ ...OPTIONS, judgePrices: { usdIn: 1e6, usdOut: 1e6 } }, deps)
  api.complete(state.reader_batch, () => 'an answer')
  const result = await step(state, deps)
  assert.equal(result.status, 'failed')
  assert.match(result.state.failure, /judge: cost bound .* exceeds/)
  assert.equal(api.files.size, 0)
})

test('a batch that ends failed or expired marks the run failed and deletes its files', async () => {
  const { api, deps } = setup()
  const state = await submitRun(OPTIONS, deps)
  api.batches.get(state.reader_batch).status = 'expired'
  const result = await step(state, deps)
  assert.equal(result.status, 'failed')
  assert.match(result.state.failure, /reader batch .* ended expired/)
  assert.equal(api.files.size, 0)
  assert.equal((await step(result.state, deps)).status, 'failed', 'failed stays failed')
  const again = await sweep(deps.client, { pending_deletes: ['file-gone'] })
  assert.deepEqual(again.pending_deletes, [], 'a file already gone counts as deleted')
})

test('with no usable answer the run is scored all wrong, billed usage kept, no judge batch', async () => {
  const { api, deps } = setup()
  const state = await submitRun(OPTIONS, deps)
  api.complete(state.reader_batch, () => null)
  const result = await step(state, deps)
  assert.equal(result.status, 'done')
  assert.equal(result.metrics.overall_accuracy, 0)
  assert.equal(result.metrics.reader_errors, 7)
  assert.deepEqual(result.metrics.usage.reader, { prompt_tokens: 700, completion_tokens: 35 })
  assert.equal(api.batches.size, 1, 'no judge batch')
  assert.equal(api.files.size, 0)
})

test('the cost bound counts UTF-8 bytes plus framing, unrounded, and refuses before uploading', async () => {
  const { api, deps } = setup()
  await assert.rejects(submitRun({ ...OPTIONS, maxUsd: 1e-9 }, deps), /cost bound .* exceeds/)
  assert.equal(api.files.size, 0)
  const answer = '᧿'.repeat(266) // 3 bytes each in UTF-8
  const request = { body: { messages: [{ content: answer }], max_tokens: 10 } }
  assert.equal(costBound([request], { usdIn: 1, usdOut: 1 }), (266 * 3 + 32 + 10) / 1e6)
})

test('submit options accept --name=value, and judge prices come as a pair', () => {
  const base = ['submit', '--reader', 'r', '--judge', 'j', '--usd-in', '1', '--usd-out', '2']
  const options = submitOptions([
    ...base,
    '--max-usd=3',
    '--limit=1',
    '--judge-usd-in=4',
    '--judge-usd-out=5',
  ])
  assert.equal(options.limit, 1, 'a smoke run stays a smoke run')
  assert.equal(options.maxUsd, 3)
  assert.deepEqual(options.judgePrices, { usdIn: 4, usdOut: 5 })
  assert.throws(() => submitOptions([...base, '--max-usd=3', '--judge-usd-out=5']), /go together/)
  assert.throws(
    () => submitOptions([...base, '--max-usd', '3', '--limit=0']),
    /--limit needs a positive/,
  )
})

test('errors never quote content, and a stalled call times out', async () => {
  const { api, deps } = setup()
  const state = await submitRun(OPTIONS, deps)
  api.nonJsonGet = true
  const notJson = await collectRun(state, deps).catch((e) => e)
  assert.ok(notJson instanceof ContentFreeError)
  assert.match(notJson.message, /response is not JSON/)
  const missing = await deps.client.content('nope').catch((e) => e)
  assert.match(missing.message, /failed with status 404/)
  let badLine
  try {
    parseBatchOutput(`{"custom_id": "q1", ${SECRET}`)
  } catch (error) {
    badLine = error
  }
  assert.ok(badLine instanceof ContentFreeError)
  for (const error of [notJson, missing, badLine]) {
    assert.equal(error.message.includes('SECRET'), false)
  }
  const slow = setup({ timeoutMs: 20 })
  slow.api.hang = true
  await assert.rejects(slow.deps.client.get('batch-1'), /GET \/batches: TimeoutError/)
  assert.throws(() => createBatchClient({ apiKey: '' }), /API key is required/)
})
