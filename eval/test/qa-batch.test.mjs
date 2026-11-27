// SPDX-License-Identifier: Apache-2.0
// LongMemEval QA through the Batch API (#535), against a fake Batch API: no
// network, no model. Submit, poll, judge, score; the state saved after every
// paid step; retries that adopt instead of paying twice; files deleted only
// once the state lets them go; ids-only state; content-free errors.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ContentFreeError } from '../src/content-free-error.mjs'
import { createBatchClient } from '../src/openai-batch.mjs'
import { parseBatchOutput } from '../src/qa.mjs'
import { collectRun, costBound, submitOptions, submitRun, sweep } from '../src/qa-batch.mjs'

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
}
const SECRET = 'SECRET answer text'

/** An in-memory Batch API: files, batches, a hook to finish a batch, and failure switches. */
function fakeOpenAI() {
  const files = new Map()
  const batches = new Map()
  const api = { files, batches, gets: 0, createMode: 'ok', nonJsonGet: false }
  let next = 0
  const reply = (status, body) => new Response(JSON.stringify(body), { status })
  api.fetch = async (url, init) => {
    const { pathname, search } = new URL(url)
    const path = pathname.replace(/^\/v1/, '')
    const id = path.split('/')[2]
    if (init.method === 'POST' && path === '/files') {
      const fileId = `file-${++next}`
      files.set(fileId, await init.body.get('file').text())
      return reply(200, { id: fileId })
    }
    if (init.method === 'POST' && path === '/batches') {
      const input = JSON.parse(init.body).input_file_id
      if (api.createMode === 'fail') return reply(500, { error: SECRET })
      const batch = { id: `batch-${++next}`, status: 'in_progress', input_file_id: input }
      batches.set(batch.id, batch)
      // 'lost': the batch exists, but its response never reaches the caller.
      return api.createMode === 'lost' ? reply(502, { error: SECRET }) : reply(200, batch)
    }
    if (init.method === 'GET' && path === '/batches' && search === '?limit=100') {
      return reply(200, { data: [...batches.values()].reverse() })
    }
    if (init.method === 'GET' && batches.has(id)) {
      api.gets++
      return api.nonJsonGet ? new Response(`not json ${SECRET}`) : reply(200, batches.get(id))
    }
    if (init.method === 'GET' && path.endsWith('/content') && files.has(id)) {
      return new Response(files.get(id))
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
      .trim()
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
    const outputId = `file-${++next}`
    files.set(outputId, out.join('\n'))
    Object.assign(batch, { status: 'completed', output_file_id: outputId })
  }
  return api
}

/** A state file in memory; `failAt` makes that save (1-based) throw, as a full disk would. */
function store(failAt) {
  const saves = []
  return {
    saves,
    last: () => saves.at(-1),
    save: (state) => {
      if (saves.length + 1 === failAt) {
        saves.push(null)
        throw new Error('disk full')
      }
      saves.push(structuredClone(state))
    },
  }
}

function setup({ failAt } = {}) {
  const api = fakeOpenAI()
  const client = createBatchClient({
    baseUrl: 'https://api.test/v1/',
    apiKey: 'k',
    fetch: api.fetch,
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
    disk.saves.map((s) => s.stage),
    ['reader-prepare', 'reader-start', 'reader'],
    'saved before the upload, after it, and after the batch exists',
  )
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

test('a save that fails after an upload deletes the upload, so nothing paid is untracked', async () => {
  const { api, deps } = setup({ failAt: 2 })
  await assert.rejects(submitRun(OPTIONS, deps), /the step it records was undone/)
  assert.equal(api.files.size, 0)
  assert.equal(api.batches.size, 0)
})

test('a batch whose create response was lost is adopted on retry, never created twice', async () => {
  const { api, disk, deps } = setup()
  api.createMode = 'lost'
  await assert.rejects(submitRun(OPTIONS, deps), /failed with status 502/)
  const saved = disk.last()
  assert.equal(saved.stage, 'reader-start', 'the upload is on record')
  api.createMode = 'ok'
  const result = await collectRun(saved, deps)
  assert.equal(result.status, 'started')
  assert.equal(api.batches.size, 1, 'the existing batch was adopted')
  assert.equal(result.state.reader_batch, [...api.batches.keys()][0])
})

test('a judge batch that fails to start leaves the run resumable from its saved upload', async () => {
  const { api, disk, deps } = setup()
  const state = await submitRun(OPTIONS, deps)
  api.complete(state.reader_batch, () => 'an answer')
  api.createMode = 'fail'
  await assert.rejects(collectRun(state, deps), /POST \/batches failed with status 500/)
  const saved = disk.last()
  assert.equal(saved.stage, 'judge-start')
  api.createMode = 'ok'
  assert.equal((await step(saved, deps)).status, 'started')
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
  // Deleting a file that is already gone counts as done, so a repeat sweep converges.
  const again = await sweep(deps.client, { pending_deletes: ['file-gone'] })
  assert.deepEqual(again.pending_deletes, [])
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

test('submit options accept --name=value as well as --name value', () => {
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
  assert.throws(
    () => submitOptions([...base, '--max-usd', '3', '--limit=0']),
    /--limit needs a positive/,
  )
})

test('errors never quote content: API bodies, non-JSON replies and bad output lines', async () => {
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
  assert.throws(() => createBatchClient({ apiKey: '' }), /API key is required/)
})
