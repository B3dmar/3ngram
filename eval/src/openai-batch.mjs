// SPDX-License-Identifier: Apache-2.0
// A minimal OpenAI Batch API client for the LongMemEval QA runs (#535): upload
// a named JSONL input file, create a 24h batch against /v1/chat/completions
// with metadata, read and cancel batches, fetch and delete files, and find
// files by name or batches by metadata across every page of the listings.
//
// ADVISORY ONLY. Errors carry the method, endpoint and HTTP status, never a
// response body: bodies can hold prompts and answers (hard rule 6).

import { ContentFreeError } from './content-free-error.mjs'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
/** A bounded deadline per call; an upload of the full oracle input is about 15 MB. */
const DEFAULT_TIMEOUT_MS = 120_000

/** Statuses after which a batch changes no more (Batch API reference). */
export const FINAL_STATUSES = Object.freeze(['completed', 'failed', 'expired', 'cancelled'])

export function createBatchClient({
  baseUrl,
  apiKey,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!apiKey) throw new ContentFreeError('an API key is required (LLM_GATEWAY_API_KEY)')
  const root = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const where = (method, path) => `batch API ${method} /${path.split(/[/?]/)[1]}`

  async function call(method, path, { body, json, absentOk = false } = {}) {
    const headers = { authorization: `Bearer ${apiKey}` }
    if (json !== undefined) headers['content-type'] = 'application/json'
    let response
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers,
        body: json === undefined ? body : JSON.stringify(json),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new ContentFreeError(`${where(method, path)}: ${error.name}`) // timeout or network
    }
    if (absentOk && response.status === 404) return response
    if (!response.ok) {
      await response.text().catch(() => undefined) // drained, never logged
      throw new ContentFreeError(`${where(method, path)} failed with status ${response.status}`)
    }
    return response
  }

  /** A response body as JSON; a body that is not JSON is reported without quoting it. */
  async function json(method, path, options) {
    const response = await call(method, path, options)
    try {
      return await response.json()
    } catch {
      throw new ContentFreeError(`${where(method, path)}: response is not JSON`)
    }
  }

  /** Every item of a cursor-paginated listing (`after` the last id while `has_more`). */
  async function* pages(base) {
    let after
    do {
      const page = await json('GET', after ? `${base}&after=${after}` : base)
      const data = page.data ?? []
      yield* data
      after = page.has_more && data.length > 0 ? data.at(-1).id : undefined
    } while (after)
  }

  return {
    /** Upload request lines as a named JSONL file for the Batch API; returns its file id. */
    async upload(lines, filename) {
      const form = new FormData()
      form.append('purpose', 'batch')
      const jsonl = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
      form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), filename)
      return (await json('POST', '/files', { body: form })).id
    },
    /** Create a 24h /v1/chat/completions batch over an uploaded file. */
    async create(inputFileId, metadata = {}) {
      const body = {
        input_file_id: inputFileId,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
        metadata,
      }
      return json('POST', '/batches', { json: body })
    },
    get: (batchId) => json('GET', `/batches/${batchId}`),
    cancel: (batchId) => json('POST', `/batches/${batchId}/cancel`),
    async content(fileId) {
      return (await call('GET', `/files/${fileId}/content`)).text()
    },
    /** Delete a file; one already gone (404) counts as deleted, so a retried sweep converges. */
    async remove(fileId) {
      await call('DELETE', `/files/${fileId}`, { absentOk: true })
    },
    /** Every batch-purpose file whose name starts with `prefix`, across all pages. */
    async filesNamed(prefix) {
      const found = []
      for await (const file of pages('/files?purpose=batch&limit=10000')) {
        if (typeof file.filename === 'string' && file.filename.startsWith(prefix)) found.push(file)
      }
      return found
    },
    /** Every batch whose metadata matches all of `match`, across all pages. */
    async batchesTagged(match) {
      const found = []
      for await (const batch of pages('/batches?limit=100')) {
        if (Object.entries(match).every(([k, v]) => batch.metadata?.[k] === v)) found.push(batch)
      }
      return found
    },
  }
}
