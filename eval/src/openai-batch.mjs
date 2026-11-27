// SPDX-License-Identifier: Apache-2.0
// A minimal OpenAI Batch API client for the LongMemEval QA runs (#535): upload
// a JSONL input file, create a 24h batch against /v1/chat/completions, read
// its status, fetch output and error files, delete files.
//
// ADVISORY ONLY. Errors carry the method, endpoint and HTTP status, never a
// response body: bodies can hold prompts and answers (hard rule 6).

import { ContentFreeError } from './content-free-error.mjs'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/** Statuses after which a batch changes no more (Batch API reference). */
export const FINAL_STATUSES = Object.freeze(['completed', 'failed', 'expired', 'cancelled'])

export function createBatchClient({ baseUrl, apiKey, fetch: fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new ContentFreeError('an API key is required (LLM_GATEWAY_API_KEY)')
  const root = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')

  async function call(method, path, { body, json } = {}) {
    const headers = { authorization: `Bearer ${apiKey}` }
    if (json !== undefined) headers['content-type'] = 'application/json'
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers,
      body: json === undefined ? body : JSON.stringify(json),
    })
    if (!response.ok) {
      await response.text().catch(() => undefined) // drained, never logged
      throw new ContentFreeError(
        `batch API ${method} /${path.split('/')[1]} failed with status ${response.status}`,
      )
    }
    return response
  }

  /** A response body as JSON; a body that is not JSON is reported without quoting it. */
  async function json(response, method, path) {
    try {
      return await response.json()
    } catch {
      throw new ContentFreeError(`batch API ${method} /${path.split('/')[1]}: response is not JSON`)
    }
  }

  return {
    /** Upload request lines as a JSONL file for the Batch API; returns its file id. */
    async upload(lines) {
      const form = new FormData()
      form.append('purpose', 'batch')
      const jsonl = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
      form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'batch.jsonl')
      return (await json(await call('POST', '/files', { body: form }), 'POST', '/files')).id
    },
    /** Create a 24h /v1/chat/completions batch over an uploaded file. */
    async create(inputFileId, metadata = {}) {
      const body = {
        input_file_id: inputFileId,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
        metadata,
      }
      return json(await call('POST', '/batches', { json: body }), 'POST', '/batches')
    },
    async get(batchId) {
      const path = `/batches/${batchId}`
      return json(await call('GET', path), 'GET', path)
    },
    async content(fileId) {
      return (await call('GET', `/files/${fileId}/content`)).text()
    },
    async remove(fileId) {
      await call('DELETE', `/files/${fileId}`)
    },
  }
}
