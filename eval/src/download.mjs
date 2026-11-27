// SPDX-License-Identifier: Apache-2.0
// --download slice: fetch the full 500q LongMemEval-S haystack.
//
// ADVISORY ONLY: this never gates a PR. It streams the upstream
// dataset to a GITIGNORED cache (eval/.cache/, see root .gitignore) and runs
// the same deterministic retrieval-oracle metrics over it. The dataset carries
// an upstream license and is large (~hundreds of MB), so it is NEVER committed.
//
// Integrity: the streamed file is verified by byte size and SHA-256. A re-run
// reuses a verified cache file (idempotent) instead of re-downloading; pass
// --force to overwrite. The release is PINNED in code (DEFAULT_SHA256 /
// DEFAULT_BYTES, measured 2026-11-09 for #449) so the sampled real-retriever
// lane always scores the file its question ids were drawn from. Env overrides
// the pin, so a new upstream release is still a config change:
//   LONGMEMEVAL_S_URL        upstream URL (default: the HuggingFace release)
//   LONGMEMEVAL_S_SHA256     expected SHA-256 (default: DEFAULT_SHA256)
//   LONGMEMEVAL_S_BYTES      expected byte size (default: DEFAULT_BYTES)

import { createHash } from 'node:crypto'
import { closeSync, createWriteStream, openSync, readSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const CACHE_DIR = join(here, '../.cache')
export const DATASET_FILENAME = 'longmemeval_s.json'

// --- MemoryAgentBench (MAB) subsets (advisory tier) ---------------------------
// The two advisory subsets. Upstream is the MIT-licensed `ai-hyz/MemoryAgentBench`
// HuggingFace dataset; each subset is a single parquet file. We PIN url + sha256
// + bytes per subset so a new upstream release is a config change, not a code
// change. The sha256 values are the HuggingFace Git-LFS `oid sha256` (== the
// sha256 of the file content) read from the LFS pointer; the bytes are the LFS
// `size`. Parquet DECODING is deferred (no parquet dependency added this batch),
// so the download lane verifies integrity only — see memoryagentbench.mjs.
export const MAB_SUBSETS = ['conflict-resolution', 'test-time-learning']

const MAB_SUBSET_CONFIG = {
  'conflict-resolution': {
    filename: 'mab_conflict_resolution.parquet',
    url: 'https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/resolve/main/data/Conflict_Resolution-00000-of-00001.parquet',
    sha256: '24d5c3f09ce0ce15625cb9f8a98f44f0d864ca6c94d7b4ad04eb697ca3a5ff45',
    bytes: 1491588,
    urlEnv: 'MAB_CONFLICT_RESOLUTION_URL',
    sha256Env: 'MAB_CONFLICT_RESOLUTION_SHA256',
    bytesEnv: 'MAB_CONFLICT_RESOLUTION_BYTES',
  },
  'test-time-learning': {
    filename: 'mab_test_time_learning.parquet',
    url: 'https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/resolve/main/data/Test_Time_Learning-00000-of-00001.parquet',
    sha256: '5338753be48f925d03318eed66117286e3489025fabe050a547bd086cd7d79c0',
    bytes: 3947476,
    urlEnv: 'MAB_TEST_TIME_LEARNING_URL',
    sha256Env: 'MAB_TEST_TIME_LEARNING_SHA256',
    bytesEnv: 'MAB_TEST_TIME_LEARNING_BYTES',
  },
}

// GitHub Actions exports an unset `vars.*` to a step as an empty string, not as
// unset, so `??` never falls back. Coerce empty/whitespace-only values to
// undefined so the documented defaults (DEFAULT_URL, skip-when-unset integrity)
// hold whether the env var is truly unset or set to ''.
function envOrUndefined(value) {
  return value != null && String(value).trim() !== '' ? value : undefined
}

// Upstream default. Overridable so a new release needs no code change. The
// upstream entry is `longmemeval_s` (no extension); the `.json` path 404s.
const DEFAULT_URL =
  'https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s'

/** The pinned LongMemEval-S release (#449). The 50q sample records the same hash. */
export const DEFAULT_SHA256 = '08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894'
export const DEFAULT_BYTES = 278025796

/**
 * The pinned LongMemEval-M release: about 500 sessions per question, the set
 * the paper's retrieval tables use. 2.7 GB, so it is read with readJsonArray,
 * never as one string. `--dataset m`; LONGMEMEVAL_M_URL / _SHA256 / _BYTES
 * override it as the S variables do.
 */
export const LONGMEMEVAL_M = Object.freeze({
  url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_m',
  sha256: 'fb5413e3b077c62927daab794836991a2fcfa61ceacab57dc679fb02daaff2d9',
  bytes: 2745274681,
  filename: 'longmemeval_m.json',
})

/**
 * The pinned LongMemEval oracle release: each question's evidence sessions
 * only, the input of the paper's oracle QA results (#535). `--dataset oracle`;
 * LONGMEMEVAL_ORACLE_URL / _SHA256 / _BYTES override it.
 */
export const LONGMEMEVAL_ORACLE = Object.freeze({
  url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_oracle',
  sha256: '821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c',
  bytes: 15388478,
  filename: 'longmemeval_oracle.json',
})

/** The dataset variants `--dataset` accepts: the pinned release and its env prefix. */
const VARIANTS = Object.freeze({
  s: {
    url: DEFAULT_URL,
    sha256: DEFAULT_SHA256,
    bytes: DEFAULT_BYTES,
    filename: DATASET_FILENAME,
    env: 'LONGMEMEVAL_S',
  },
  m: { ...LONGMEMEVAL_M, env: 'LONGMEMEVAL_M' },
  oracle: { ...LONGMEMEVAL_ORACLE, env: 'LONGMEMEVAL_ORACLE' },
})
export const DATASET_VARIANTS = Object.freeze(Object.keys(VARIANTS))

const OPEN_BRACE = 0x7b
const OPEN_BRACKET = 0x5b
const CLOSE_BRACE = 0x7d
const CLOSE_BRACKET = 0x5d
const QUOTE = 0x22
const BACKSLASH = 0x5c
const COMMA = 0x2c
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d])

/**
 * The elements of a top-level JSON array of objects, parsed one at a time from
 * the file's bytes. The -M file is longer than the longest string V8 allows,
 * so it is never read whole. Scanning bytes is safe in UTF-8: a quote or
 * backslash byte never occurs inside a multi-byte character. The outer array
 * is checked strictly (separators, object elements only, nothing after it, no
 * truncation) and JSON.parse checks each element, so a malformed file throws
 * instead of yielding fewer questions.
 */
export function* readJsonArray(path, chunkSize = 1 << 24) {
  const fd = openSync(path, 'r')
  const buffer = Buffer.alloc(chunkSize)
  const state = { outer: 'start', depth: 0, inString: false, escaped: false, parts: [], offset: 0 }
  try {
    for (let n = readSync(fd, buffer, 0, chunkSize, null); n > 0; ) {
      yield* scanChunk(buffer.subarray(0, n), state)
      n = readSync(fd, buffer, 0, chunkSize, null)
    }
  } finally {
    closeSync(fd)
  }
  if (state.outer !== 'end') {
    throw malformed(state, state.depth > 0 ? 'truncated element' : 'truncated array')
  }
}

function malformed(state, what) {
  return new Error(`readJsonArray: ${what} at byte ${state.offset}`)
}

/** One byte between elements, against the outer array's grammar. True when an element starts. */
function outerByte(byte, state) {
  if (WHITESPACE.has(byte)) return false
  const { outer } = state
  if (outer === 'start' && byte === OPEN_BRACKET) state.outer = 'first'
  else if ((outer === 'first' || outer === 'after') && byte === CLOSE_BRACKET) state.outer = 'end'
  else if (outer === 'after' && byte === COMMA) state.outer = 'next'
  else if ((outer === 'first' || outer === 'next') && byte === OPEN_BRACE) return true
  else if (outer === 'end') throw malformed(state, 'content after the array')
  else
    throw malformed(
      state,
      `unexpected byte 0x${byte.toString(16)}: only an array of objects is read`,
    )
  return false
}

/** Scan one chunk, yielding every element that closes in it; an open element carries over. */
function* scanChunk(chunk, state) {
  let start = state.parts.length > 0 ? 0 : -1
  for (let i = 0; i < chunk.length; i++, state.offset++) {
    const byte = chunk[i]
    if (state.depth === 0) {
      if (outerByte(byte, state)) {
        state.depth = 1
        start = i
      }
    } else if (state.inString) {
      if (state.escaped) state.escaped = false
      else if (byte === BACKSLASH) state.escaped = true
      else if (byte === QUOTE) state.inString = false
    } else if (byte === QUOTE) {
      state.inString = true
    } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      state.depth++
    } else if ((byte === CLOSE_BRACE || byte === CLOSE_BRACKET) && --state.depth === 0) {
      state.parts.push(Buffer.from(chunk.subarray(start, i + 1)))
      yield JSON.parse(Buffer.concat(state.parts).toString('utf8'))
      state.parts = []
      start = -1
      state.outer = 'after'
    }
  }
  if (start !== -1) state.parts.push(Buffer.from(chunk.subarray(start)))
}

/** SHA-256 hex digest of a file, streamed (never loads it fully into memory). */
export async function hashFile(path) {
  const hash = createHash('sha256')
  await pipeline(Readable.from(openChunks(path)), hash)
  return hash.digest('hex')
}

async function* openChunks(path) {
  const { createReadStream } = await import('node:fs')
  for await (const chunk of createReadStream(path)) yield chunk
}

/**
 * Verify a cached file against the expected size/hash. Returns
 * { ok, reason, bytes, sha256 }. Missing expectations are treated as
 * "not checked" (ok stays true for that dimension) so a first run without
 * pinned metadata still succeeds and reports the observed values to pin.
 */
export async function verifyFile(path, expected = {}) {
  let bytes
  try {
    bytes = (await stat(path)).size
  } catch {
    return { ok: false, reason: 'missing', bytes: 0, sha256: '' }
  }
  if (expected.bytes != null && bytes !== Number(expected.bytes)) {
    return { ok: false, reason: `size mismatch: ${bytes} != ${expected.bytes}`, bytes, sha256: '' }
  }
  let sha256 = ''
  if (expected.sha256) {
    sha256 = await hashFile(path)
    if (sha256 !== expected.sha256) {
      return {
        ok: false,
        reason: `sha256 mismatch: ${sha256} != ${expected.sha256}`,
        bytes,
        sha256,
      }
    }
  }
  return { ok: true, reason: 'verified', bytes, sha256 }
}

/**
 * Ensure the dataset exists at the cache path and passes integrity checks.
 * Idempotent: a verified cache file is reused; otherwise it is (re)downloaded
 * to a temp file, verified, then atomically renamed into place.
 *
 * `deps` is injectable for tests: { fetch, cacheDir }.
 */
export async function ensureDataset(options = {}, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const cacheDir = deps.cacheDir ?? CACHE_DIR
  const variant = VARIANTS[options.variant ?? 's']
  if (!variant) throw new Error(`unknown dataset: ${options.variant} (known: ${DATASET_VARIANTS})`)
  const fromEnv = (suffix) => envOrUndefined(process.env[`${variant.env}_${suffix}`])
  const url = options.url ?? fromEnv('URL') ?? variant.url
  const expected = {
    sha256: options.sha256 ?? fromEnv('SHA256') ?? variant.sha256,
    bytes: options.bytes ?? fromEnv('BYTES') ?? variant.bytes,
  }
  const target = join(cacheDir, variant.filename)

  if (!options.force) {
    const cached = await verifyFile(target, expected)
    if (cached.ok) {
      return { path: target, cached: true, bytes: cached.bytes, sha256: cached.sha256, url }
    }
  }

  return fetchVerified({ url, target, cacheDir, expected, fetchImpl })
}

/**
 * Download `url` to `target` (within `cacheDir`), verify integrity, then
 * atomically rename into place. Shared by the LongMemEval and MemoryAgentBench
 * lanes so the fetch → verify → atomic-rename contract is identical. Streams to
 * a temp file (never loads the body fully into memory) and cleans the temp file
 * on any failure so a bad download never lands at `target`.
 */
async function fetchVerified({ url, target, cacheDir, expected, fetchImpl }) {
  await mkdir(cacheDir, { recursive: true })
  const tmp = `${target}.tmp-${process.pid}`
  try {
    const res = await fetchImpl(url)
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`)
    if (!res.body) throw new Error('download failed: empty response body')
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))

    const check = await verifyFile(tmp, expected)
    if (!check.ok) throw new Error(`integrity check failed (${check.reason})`)

    await rename(tmp, target)
    return { path: target, cached: false, bytes: check.bytes, sha256: check.sha256, url }
  } finally {
    await rm(tmp, { force: true })
  }
}

/**
 * Ensure a MemoryAgentBench subset parquet (issue #294) exists in the cache and
 * passes integrity checks. Same idempotent fetch → verify → atomic-rename
 * contract as ensureDataset, with the same empty-string-safe env override
 * pattern (GH exports unset `vars.*` as ''): per subset, the pinned url/sha256/
 * bytes are overridable via MAB_<SUBSET>_URL / _SHA256 / _BYTES so a new
 * upstream release is config, not code. The parquet is large + upstream-licensed
 * and is NEVER committed (gitignored cache).
 *
 * `deps` is injectable for tests: { fetch, cacheDir }.
 */
export async function ensureMemoryAgentBenchSubset(subset, options = {}, deps = {}) {
  const config = MAB_SUBSET_CONFIG[subset]
  if (!config) {
    throw new Error(`unknown MAB subset: ${subset} (known: ${MAB_SUBSETS.join(', ')})`)
  }
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const cacheDir = deps.cacheDir ?? CACHE_DIR
  const url = options.url ?? envOrUndefined(process.env[config.urlEnv]) ?? config.url
  const expected = {
    sha256: options.sha256 ?? envOrUndefined(process.env[config.sha256Env]) ?? config.sha256,
    bytes: options.bytes ?? envOrUndefined(process.env[config.bytesEnv]) ?? config.bytes,
  }
  const target = join(cacheDir, config.filename)

  if (!options.force) {
    const cached = await verifyFile(target, expected)
    if (cached.ok) {
      return { path: target, cached: true, bytes: cached.bytes, sha256: cached.sha256, url, subset }
    }
  }

  const result = await fetchVerified({ url, target, cacheDir, expected, fetchImpl })
  return { ...result, subset }
}
