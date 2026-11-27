// SPDX-License-Identifier: Apache-2.0
// LongMemEval QA through the Batch API (#535), against a fake Batch API: no
// network, no model. Submit, poll, judge, score; files deleted; ids-only state.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createBatchClient } from '../src/openai-batch.mjs'
import { parseBatchOutput } from '../src/qa.mjs'
import { collectRun, costBound, submitRun } from '../src/qa-batch.mjs'

const { cases } = JSON.parse(
  readFileSync(new URL('../fixtures/qa-parity.json', import.meta.url), 'utf8'),
)
const entries = cases.map((c) => c.entry)
const loadEntries = async () => ({ dataset: 'oracle', sha256: 'abc', entries })
const PRICES = { usdIn: 1.25, usdOut: 5 }

/** An in-memory Batch API: files, batches, and a hook to complete a batch. */
function fakeOpenAI() {
  const files = new Map()
  const batches = new Map()
  let next = 0
  const reply = (status, body) => new Response(JSON.stringify(body), { status })
  async function fetch(url, init) {
    const path = new URL(url).pathname.replace(/^\/v1/, '')
    const id = path.split('/')[2]
    if (init.method === 'POST' && path === '/files') {
      const fileId = `file-${++next}`
      files.set(fileId, await init.body.get('file').text())
      return reply(200, { id: fileId })
    }
    if (init.method === 'POST' && path === '/batches') {
      const batch = {
        id: `batch-${++next}`,
        status: 'in_progress',
        input: JSON.parse(init.body).input_file_id,
      }
      batches.set(batch.id, batch)
      return reply(200, batch)
    }
    if (init.method === 'GET' && batches.has(id)) return reply(200, batches.get(id))
    if (init.method === 'GET' && path.endsWith('/content')) return new Response(files.get(id))
    if (init.method === 'DELETE' && files.delete(id)) return reply(200, { deleted: true })
    return reply(404, { error: 'SECRET body text' })
  }
  /** Complete a batch, answering each request line with `answer(line)`. */
  function complete(batchId, answer) {
    const batch = batches.get(batchId)
    const lines = files
      .get(batch.input)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const out = lines.map((line) =>
      JSON.stringify({
        custom_id: line.custom_id,
        response: {
          status_code: 200,
          body: {
            choices: [{ message: { content: answer(line) } }],
            usage: { prompt_tokens: 100, completion_tokens: 5 },
          },
        },
        error: null,
      }),
    )
    const outputId = `file-${++next}`
    files.set(outputId, out.join('\n'))
    Object.assign(batch, { status: 'completed', output_file_id: outputId })
  }
  return { fetch, files, batches, complete }
}

test('a run submits the reader, then the judge, then scores; every batch file is deleted (#535)', async () => {
  const api = fakeOpenAI()
  const client = createBatchClient({
    baseUrl: 'https://api.test/v1/',
    apiKey: 'k',
    fetch: api.fetch,
  })
  const deps = { client, loadEntries, parse: parseBatchOutput }
  const options = {
    reader: 'gpt-4o-2024-08-06',
    judge: 'gpt-4o-2024-08-06',
    prices: PRICES,
    maxUsd: 5,
  }

  let state = await submitRun(options, deps)
  assert.equal(state.stage, 'reader')
  assert.equal(state.question_ids.length, 7)
  assert.equal((await collectRun(state, deps)).status, 'pending', 'still running')

  api.complete(state.reader_batch, (line) => `answer for ${line.custom_id}`)
  let step = await collectRun(state, deps)
  assert.equal(step.status, 'judging')
  state = step.state
  assert.deepEqual(state.reader_usage, { prompt_tokens: 700, completion_tokens: 35 })

  // The judge says yes except for the temporal question.
  api.complete(state.judge_batch, (line) => (line.custom_id === 'q-order' ? 'No.' : 'Yes'))
  step = await collectRun(state, deps)
  assert.equal(step.status, 'done')
  const { metrics } = step
  assert.equal(metrics.questions, 7)
  assert.equal(metrics.judge, 'gpt-4o-2024-08-06')
  assert.equal(metrics.upstream_judge, true, "the anchor judge is upstream's")
  assert.equal(metrics.overall_accuracy, +(6 / 7).toFixed(4))
  assert.deepEqual(metrics.by_type['temporal-reasoning'], { n: 1, accuracy: 0 })
  assert.equal(metrics.cost_usd, +((1400 * 1.25 + 70 * 5) / 1e6).toFixed(4))
  assert.equal(api.files.size, 0, 'inputs and outputs deleted at OpenAI')
  // Hard rule 6: neither the state nor the metrics carry prompt or answer text.
  for (const value of [step.state, metrics]) {
    const text = JSON.stringify(value)
    assert.equal(text.includes('Synthetic question'), false)
    assert.equal(text.includes('answer for'), false)
  }
})

test('the cost guard refuses a run whose bound exceeds the cap, before uploading anything', async () => {
  const api = fakeOpenAI()
  const client = createBatchClient({ apiKey: 'k', fetch: api.fetch })
  const options = { reader: 'r', judge: 'j', prices: PRICES, maxUsd: 0.0001 }
  await assert.rejects(
    submitRun(options, { client, loadEntries }),
    /cost bound .* exceeds --max-usd/,
  )
  assert.equal(api.files.size, 0)
})

test('the cost bound is request characters plus max_tokens, priced per million', () => {
  const request = { body: { messages: [{ content: 'x'.repeat(1000) }], max_tokens: 10 } }
  assert.equal(
    costBound([request], { usdIn: 2, usdOut: 10 }),
    +((1000 * 2 + 10 * 10) / 1e6).toFixed(4),
  )
})

test('a failed batch stops the run; API errors carry the status, never the body', async () => {
  const api = fakeOpenAI()
  const client = createBatchClient({ apiKey: 'k', fetch: api.fetch })
  const deps = { client, loadEntries, parse: parseBatchOutput }
  const state = await submitRun({ reader: 'r', judge: 'j', prices: PRICES, maxUsd: 5 }, deps)
  api.batches.get(state.reader_batch).status = 'expired'
  await assert.rejects(collectRun(state, deps), /reader batch .* ended expired/)
  const error = await client.get('missing').catch((e) => e)
  assert.match(error.message, /failed with status 404/)
  assert.equal(error.message.includes('SECRET'), false)
  assert.throws(() => createBatchClient({ apiKey: '' }), /API key is required/)
})
