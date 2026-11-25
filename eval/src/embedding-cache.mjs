// SPDX-License-Identifier: Apache-2.0
// Content-addressed embedding cache for the advisory real-retriever lane (#449).
//
// ADVISORY ONLY: nothing here gates a PR. It decorates the packages/llm Gateway
// interface (embed / complete / decide): embed() serves a stored vector when the
// exact text was embedded before with the same model and dimensions, and calls
// the wrapped gateway otherwise. The product write path is unchanged:
// core.remember still embeds through the gateway seam; only where the vector
// comes from differs. A key that misses costs a live call, never a wrong vector.
//
// Determinism: every vector, live or cached, is served after a float32 round
// trip, so a cold run (live fill) and a warm run (cache) score identical vectors
// and a night-over-night change means product code changed.
//
// Provenance: the header records the model the gateway actually served
// (`served_model`), and embed() reports it. A live call that reports a different
// served model than the cached vectors came from throws, so a run never mixes
// vectors from two models; a changed gateway needs a fresh cache.
//
// Storage: one JSONL file. Line 1 is a header {version, model, dimensions,
// served_model}; every later line is {k: sha256 hex of the text key, v: base64
// little-endian float32, c: checksum of those bytes}. A header that does not
// match ignores the whole file. A line that does not parse, fails its checksum,
// or holds a wrong-width or non-finite vector is dropped and fetched again. A
// file with a dropped line or an unterminated last line is rewritten whole,
// atomically, on save, so an append can never fuse onto a partial row. The file
// holds hashes and vectors only, never text (hard rule 6).
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

const CACHE_VERSION = 2
const PREFILL_OPERATION = 'eval.embed-cache.prefill'

/** Cache key: sha256 over model, dimensions and the exact text embedded. */
export function embeddingKey(model, dimensions, text) {
  return createHash('sha256').update(`${model}\n${dimensions}\n${text}`).digest('hex')
}

/** Thrown when the gateway serves a different model than the cached vectors came from. */
export class ServedModelMismatchError extends Error {
  constructor(cached, served) {
    super(`gateway served ${served}, but the cached vectors came from ${cached}`)
    this.name = 'ServedModelMismatchError'
  }
}

const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16)

function toFloat32(vector, dimensions) {
  if (vector?.length !== dimensions) return null
  const f32 = Float32Array.from(vector)
  return f32.every(Number.isFinite) ? f32 : null
}

function encodeLine(key, f32) {
  const bytes = Buffer.alloc(f32.length * 4)
  for (let i = 0; i < f32.length; i++) bytes.writeFloatLE(f32[i], i * 4)
  return `${JSON.stringify({ k: key, v: bytes.toString('base64'), c: checksum(bytes) })}\n`
}

/** Parse one row; null when it does not parse, fails its checksum or holds a bad vector. */
function decodeLine(line, dimensions) {
  let row
  try {
    row = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof row?.k !== 'string' || typeof row.v !== 'string') return null
  const bytes = Buffer.from(row.v, 'base64')
  if (bytes.byteLength !== dimensions * 4 || row.c !== checksum(bytes)) return null
  const f32 = new Float32Array(dimensions)
  for (let i = 0; i < dimensions; i++) f32[i] = bytes.readFloatLE(i * 4)
  return f32.every(Number.isFinite) ? { key: row.k, f32 } : null
}

/**
 * Read a cache file into `vectors`. `appendable` is true only for a matching
 * header, no dropped row and a newline-terminated last row: anything else is
 * rewritten whole on save.
 */
function load(file, header, vectors) {
  const none = { loaded: 0, dropped: 0, appendable: false, servedModel: undefined }
  if (!existsSync(file)) return none
  const body = readFileSync(file, 'utf8')
  const [first, ...lines] = body.split('\n')
  let parsed
  try {
    parsed = JSON.parse(first)
  } catch {
    parsed = null
  }
  const matches =
    parsed?.version === header.version &&
    parsed?.model === header.model &&
    parsed?.dimensions === header.dimensions &&
    typeof parsed?.served_model === 'string'
  if (!matches) return { ...none, dropped: lines.filter((l) => l !== '').length }
  let dropped = 0
  for (const line of lines) {
    if (line === '') continue
    const row = decodeLine(line, header.dimensions)
    if (row) vectors.set(row.key, row.f32)
    else dropped++
  }
  const appendable = dropped === 0 && body.endsWith('\n')
  return { loaded: vectors.size, dropped, appendable, servedModel: parsed.served_model }
}

/**
 * Wrap `inner` (a Gateway) with the cache at `file`. `prefill(texts)` embeds
 * every uncached text in batches of `batchSize`; a failed batch is retried one
 * text per call, and a text that still fails is counted, not cached (the write
 * path then calls live, fails again and records `embed_failed`). A served-model
 * mismatch is never retried: it aborts the run. `save()` persists what this run
 * added; `stats()` returns counts and the served model only.
 */
export function createCachingGateway(inner, { file, model, dimensions, batchSize = 256 }) {
  const vectors = new Map()
  const header = { version: CACHE_VERSION, model, dimensions }
  const loadedFile = load(file, header, vectors)
  let { appendable, servedModel } = loadedFile
  // Sticky: once a served-model mismatch is seen, every later embed() rethrows
  // it. core's embed-on-write swallows a write-time error (embed_failed), but the
  // query embed that follows every question's writes is not swallowed, so the
  // run aborts at that question instead of finishing with a missing vector.
  let mismatch
  const added = []
  const counts = { hits: 0, misses: 0, live_calls: 0, live_input_tokens: 0, failed_texts: 0 }
  const keyOf = (text) => embeddingKey(model, dimensions, text)

  async function fetchLive(texts, operation) {
    counts.live_calls++
    const result = await inner.embed(texts, operation)
    counts.live_input_tokens += result.usage?.inputTokens ?? 0
    const served = result.model || model
    if (servedModel !== undefined && served !== servedModel) {
      mismatch = new ServedModelMismatchError(servedModel, served)
      throw mismatch
    }
    if (result.embeddings?.length !== texts.length) {
      throw new Error(`embedding row count ${result.embeddings?.length} != ${texts.length}`)
    }
    const f32s = result.embeddings.map((vector) => toFloat32(vector, dimensions))
    if (f32s.some((f32) => f32 === null)) {
      throw new Error('embedding of the wrong width or non-finite')
    }
    servedModel = served
    texts.forEach((text, i) => {
      const key = keyOf(text)
      if (!vectors.has(key)) added.push(key)
      vectors.set(key, f32s[i])
    })
  }

  return {
    async embed(texts, operation) {
      if (mismatch) throw mismatch
      const misses = [...new Set(texts.filter((text) => !vectors.has(keyOf(text))))]
      counts.hits += texts.length - misses.length
      counts.misses += misses.length
      const tokensBefore = counts.live_input_tokens
      if (misses.length > 0) await fetchLive(misses, operation)
      return {
        embeddings: texts.map((text) => Array.from(vectors.get(keyOf(text)))),
        usage: { inputTokens: counts.live_input_tokens - tokensBefore },
        model: servedModel ?? model,
      }
    },
    complete: (...args) => inner.complete(...args),
    decide: (...args) => inner.decide(...args),

    async prefill(texts) {
      if (mismatch) throw mismatch
      const todo = [...new Set(texts)].filter(
        (text) => text.trim().length > 0 && !vectors.has(keyOf(text)),
      )
      for (let i = 0; i < todo.length; i += batchSize) {
        const batch = todo.slice(i, i + batchSize)
        try {
          await fetchLive(batch, PREFILL_OPERATION)
        } catch (error) {
          if (error instanceof ServedModelMismatchError) throw error
          for (const text of batch) {
            try {
              await fetchLive([text], PREFILL_OPERATION)
            } catch (retryError) {
              if (retryError instanceof ServedModelMismatchError) throw retryError
              counts.failed_texts++
            }
          }
        }
      }
    },

    save() {
      if (vectors.size === 0 || (added.length === 0 && appendable)) return
      mkdirSync(dirname(file), { recursive: true })
      if (appendable) {
        appendFileSync(file, added.map((key) => encodeLine(key, vectors.get(key))).join(''))
      } else {
        // New, mismatched, damaged or unterminated file: rewrite it whole, atomically.
        const rows = [...vectors.keys()].map((key) => encodeLine(key, vectors.get(key)))
        const tmp = `${file}.tmp-${process.pid}`
        writeFileSync(
          tmp,
          `${JSON.stringify({ ...header, served_model: servedModel })}\n${rows.join('')}`,
        )
        renameSync(tmp, file)
        appendable = true
      }
      added.length = 0
    },

    stats() {
      return {
        loaded: loadedFile.loaded,
        dropped_on_load: loadedFile.dropped,
        ...counts,
        entries: vectors.size,
        served_model: servedModel ?? null,
        served_model_mismatch: mismatch !== undefined,
      }
    },
  }
}
