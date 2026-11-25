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
// Storage: one JSONL file. Line 1 is a header {version, model, dimensions};
// every later line is {k: sha256 hex, v: base64 little-endian float32}. A header
// that does not match ignores the whole file. A line that does not parse, or a
// vector of the wrong width or with a non-finite value, is dropped and fetched
// again. The file holds hashes and vectors only, never text (hard rule 6).
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

const CACHE_VERSION = 1
const PREFILL_OPERATION = 'eval.embed-cache.prefill'

/** Cache key: sha256 over model, dimensions and the exact text embedded. */
export function embeddingKey(model, dimensions, text) {
  return createHash('sha256').update(`${model}\n${dimensions}\n${text}`).digest('hex')
}

function toFloat32(vector, dimensions) {
  if (vector?.length !== dimensions) return null
  const f32 = Float32Array.from(vector)
  return f32.every(Number.isFinite) ? f32 : null
}

function encode(f32) {
  const bytes = Buffer.alloc(f32.length * 4)
  for (let i = 0; i < f32.length; i++) bytes.writeFloatLE(f32[i], i * 4)
  return bytes.toString('base64')
}

function decode(base64, dimensions) {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.byteLength !== dimensions * 4) return null
  const f32 = new Float32Array(dimensions)
  for (let i = 0; i < dimensions; i++) f32[i] = bytes.readFloatLE(i * 4)
  return f32.every(Number.isFinite) ? f32 : null
}

/** Read a cache file into `vectors`; returns how many lines were dropped. */
function load(file, header, vectors) {
  if (!existsSync(file)) return { loaded: 0, dropped: 0, valid: false }
  const [first, ...lines] = readFileSync(file, 'utf8').split('\n')
  let parsed
  try {
    parsed = JSON.parse(first)
  } catch {
    parsed = null
  }
  const matches =
    parsed?.version === header.version &&
    parsed?.model === header.model &&
    parsed?.dimensions === header.dimensions
  if (!matches) return { loaded: 0, dropped: lines.length, valid: false }
  let dropped = 0
  for (const line of lines) {
    if (line === '') continue
    try {
      const { k, v } = JSON.parse(line)
      const f32 =
        typeof k === 'string' && typeof v === 'string' ? decode(v, header.dimensions) : null
      if (f32) vectors.set(k, f32)
      else dropped++
    } catch {
      dropped++
    }
  }
  return { loaded: vectors.size, dropped, valid: true }
}

/**
 * Wrap `inner` (a Gateway) with the cache at `file`. `prefill(texts)` embeds
 * every uncached text in batches of `batchSize`; a failed batch is retried one
 * text per call, and a text that still fails is counted, not cached (the write
 * path then calls live, fails again and records `embed_failed`). `save()`
 * persists what this run added; `stats()` returns counts only.
 */
export function createCachingGateway(inner, { file, model, dimensions, batchSize = 256 }) {
  const header = { version: CACHE_VERSION, model, dimensions }
  const vectors = new Map()
  const { loaded, dropped, valid } = load(file, header, vectors)
  let fileValid = valid
  const added = []
  const counts = { hits: 0, misses: 0, live_calls: 0, live_input_tokens: 0, failed_texts: 0 }
  const keyOf = (text) => embeddingKey(model, dimensions, text)

  async function fetchLive(texts, operation) {
    counts.live_calls++
    const result = await inner.embed(texts, operation)
    counts.live_input_tokens += result.usage?.inputTokens ?? 0
    if (result.embeddings?.length !== texts.length) {
      throw new Error(`embedding row count ${result.embeddings?.length} != ${texts.length}`)
    }
    const f32s = result.embeddings.map((vector) => toFloat32(vector, dimensions))
    if (f32s.some((f32) => f32 === null))
      throw new Error('embedding of the wrong width or non-finite')
    texts.forEach((text, i) => {
      const key = keyOf(text)
      if (!vectors.has(key)) added.push(key)
      vectors.set(key, f32s[i])
    })
  }

  return {
    async embed(texts, operation) {
      const misses = [...new Set(texts.filter((text) => !vectors.has(keyOf(text))))]
      counts.hits += texts.length - misses.length
      counts.misses += misses.length
      const tokensBefore = counts.live_input_tokens
      if (misses.length > 0) await fetchLive(misses, operation)
      return {
        embeddings: texts.map((text) => Array.from(vectors.get(keyOf(text)))),
        usage: { inputTokens: counts.live_input_tokens - tokensBefore },
        model,
      }
    },
    complete: (...args) => inner.complete(...args),
    decide: (...args) => inner.decide(...args),

    async prefill(texts) {
      const todo = [...new Set(texts)].filter(
        (text) => text.trim().length > 0 && !vectors.has(keyOf(text)),
      )
      for (let i = 0; i < todo.length; i += batchSize) {
        const batch = todo.slice(i, i + batchSize)
        try {
          await fetchLive(batch, PREFILL_OPERATION)
        } catch {
          for (const text of batch) {
            try {
              await fetchLive([text], PREFILL_OPERATION)
            } catch {
              counts.failed_texts++
            }
          }
        }
      }
    },

    save() {
      if (added.length === 0 && fileValid) return
      mkdirSync(dirname(file), { recursive: true })
      const line = (key) => `${JSON.stringify({ k: key, v: encode(vectors.get(key)) })}\n`
      if (fileValid) {
        appendFileSync(file, added.map(line).join(''))
      } else {
        // No usable file yet: write header + every vector, atomically.
        const tmp = `${file}.tmp-${process.pid}`
        writeFileSync(tmp, `${JSON.stringify(header)}\n${[...vectors.keys()].map(line).join('')}`)
        renameSync(tmp, file)
        fileValid = true
      }
      added.length = 0
    },

    stats() {
      return { loaded, dropped_on_load: dropped, ...counts, entries: vectors.size }
    },
  }
}
