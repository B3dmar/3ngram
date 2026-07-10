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
// --force to overwrite. Verification metadata (size + hash) is taken from env
// so a new upstream release is a config change, not a code change:
//   LONGMEMEVAL_S_URL        upstream URL (default: the HuggingFace release)
//   LONGMEMEVAL_S_SHA256     expected SHA-256 (skips hash check when unset)
//   LONGMEMEVAL_S_BYTES      expected byte size (skips size check when unset)

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
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
  const url = options.url ?? envOrUndefined(process.env.LONGMEMEVAL_S_URL) ?? DEFAULT_URL
  const expected = {
    sha256: options.sha256 ?? envOrUndefined(process.env.LONGMEMEVAL_S_SHA256) ?? '',
    bytes: options.bytes ?? envOrUndefined(process.env.LONGMEMEVAL_S_BYTES) ?? null,
  }
  const target = join(cacheDir, DATASET_FILENAME)

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
