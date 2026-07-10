// SPDX-License-Identifier: Apache-2.0
// Dev seed for the local compose database (Phase 0 item 7, docs/concepts/local-development.mdx).
//
// Loads the anonymized eval golden set (158 memories incl. supersession
// chains) under a dev user, exercising the same RLS gate as the app:
// the OWNER connection only ensures the user row exists; all domain writes
// run on the RUNTIME (app_user) connection inside a transaction with
// set_config('app.user_id', ...) — mirroring withTenant() and the
// integration-test helpers.
//
// Idempotent the append-only way (AGENTS.md hard rule 1): rows already
// present (matched by content_hash) are skipped, never deleted.
//
// Embeddings: the cached real-model golden-set vectors
// (eval/fixtures/embeddings-openai-large-1536.json, keyed by golden id) are
// loaded into the `embedding` column so the seeded data exercises the REAL
// fused vector leg — no API calls (the vectors are committed fixtures). This is
// what lets the golden-set-through-real-path integration test score the vector
// leg against the same embeddings the blocking exact-cosine eval gate uses. A
// golden row missing from the embeddings fixture is seeded with a NULL
// embedding (the vector leg simply skips it, as in production).
//
// Preconditions (see docs/concepts/local-development.mdx):
//   docker compose up -d postgres redis
//   pnpm db:migrate
//   psql "$DATABASE_URL_UNPOOLED" -f scripts/provision-roles.sql   # after migrate
//   psql "$DATABASE_URL_UNPOOLED" -c "ALTER ROLE app_user PASSWORD '...'"
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const DEV_EMAIL = process.env.SEED_EMAIL ?? 'dev@localhost'
const PROJECT = '3ngram-dev'
// Name marker for the idempotent self-host demo API key (skip if already present).
const API_KEY_NAME = 'self-host demo'
// Replicates packages/core/src/auth/api-keys.ts WITHOUT importing it (seed stays
// node:* + pg only, no workspace deps): `3ng_<prefix>_<secret>`, key_hash =
// sha256(fullKey) hex, plus the plaintext prefix for indexed lookup.
const KEY_SCHEME_PREFIX = '3ng_'
const KEY_PREFIX_BYTES = 6
const KEY_SECRET_BYTES = 32

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set (see docs/concepts/local-development.mdx)`)
  return value
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'eval',
  'fixtures',
)
const goldenSetPath = join(fixturesDir, 'golden-set.json')
const embeddingsPath = join(fixturesDir, 'embeddings-openai-large-1536.json')

/** pgvector text literal (`[a,b,c]`) for a cached float vector, or null. */
function toVectorLiteral(vector) {
  return vector ? `[${vector.join(',')}]` : null
}

async function main() {
  const golden = JSON.parse(readFileSync(goldenSetPath, 'utf8'))
  const embeddings = JSON.parse(readFileSync(embeddingsPath, 'utf8')).memories
  const owner = new pg.Client({ connectionString: requireEnv('DATABASE_URL_UNPOOLED') })
  const runtime = new pg.Client({ connectionString: requireEnv('DATABASE_URL') })
  await owner.connect()
  await runtime.connect()

  try {
    const userResult = await owner.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x')
       ON CONFLICT (email) DO UPDATE SET updated_at = now() RETURNING id`,
      [DEV_EMAIL],
    )
    const userId = userResult.rows[0].id

    await runtime.query('BEGIN')
    await runtime.query(`SELECT set_config('app.user_id', $1, true)`, [userId])

    const existing = await runtime.query('SELECT id, content_hash FROM memories')
    const hashToDbId = new Map(existing.rows.map((row) => [row.content_hash, row.id]))

    // golden id -> db uuid, for wiring supersession edges
    const goldenToDbId = new Map()
    let inserted = 0
    let skipped = 0
    let backfilled = 0

    for (const memory of golden) {
      const hash = sha256(memory.content)
      const vec = toVectorLiteral(embeddings[memory.id])
      const known = hashToDbId.get(hash)
      if (known !== undefined) {
        goldenToDbId.set(memory.id, known)
        skipped += 1
        // Append-safe embedding backfill: a row seeded before this change has a
        // NULL embedding; fill it (never overwrite a non-NULL one — that would
        // mutate live data). COALESCE keeps the write idempotent.
        if (vec !== null) {
          const r = await runtime.query(
            `UPDATE memories SET embedding = $2::vector, updated_at = now()
             WHERE id = $1 AND embedding IS NULL`,
            [known, vec],
          )
          backfilled += r.rowCount ?? 0
        }
        continue
      }
      const row = await runtime.query(
        `INSERT INTO memories
           (user_id, memory_type, topic, content, content_hash, project, embedding,
            valid_from, recorded_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8::timestamptz, $8::timestamptz, $8::timestamptz)
         RETURNING id`,
        [userId, memory.type, memory.topic, memory.content, hash, PROJECT, vec, memory.created],
      )
      const dbId = row.rows[0].id
      goldenToDbId.set(memory.id, dbId)
      hashToDbId.set(hash, dbId)
      await runtime.query(
        `INSERT INTO memory_events (user_id, memory_id, event_kind, actor_kind, payload)
         VALUES ($1, $2, 'import', 'importer', $3)`,
        [userId, dbId, JSON.stringify({ seed: 'golden-set', golden_id: memory.id })],
      )
      inserted += 1
    }

    let edges = 0
    for (const memory of golden) {
      if (!memory.replaces) continue
      const fromId = goldenToDbId.get(memory.id)
      const toId = goldenToDbId.get(memory.replaces)
      if (fromId === undefined || toId === undefined) continue
      const edge = await runtime.query(
        `INSERT INTO memory_edges (user_id, from_id, to_id, edge_type, created_by)
         VALUES ($1, $2, $3, 'supersedes', 'importer')
         ON CONFLICT DO NOTHING`,
        [userId, fromId, toId],
      )
      if (edge.rowCount === 1) {
        // bi-temporal close of the superseded row (docs/concepts/memory-model.mdx: never delete)
        await runtime.query(
          `UPDATE memories SET valid_to = $2::timestamptz, updated_at = now()
           WHERE id = $1 AND valid_to IS NULL`,
          [toId, memory.created],
        )
        edges += 1
      }
    }

    // Demo API key for the quickstart (curl -H "X-API-Key: <key>"). RLS table,
    // so it inserts through the runtime role inside the same app.user_id tx as
    // the memories above. Idempotent: skip when a 'self-host demo' key exists —
    // we never re-mint (the plaintext is unrecoverable once issued).
    let apiKey = null
    const existingKey = await runtime.query('SELECT 1 FROM api_keys WHERE name = $1 LIMIT 1', [
      API_KEY_NAME,
    ])
    if (existingKey.rowCount === 0) {
      const prefix = randomBytes(KEY_PREFIX_BYTES).toString('base64url')
      const secret = randomBytes(KEY_SECRET_BYTES).toString('base64url')
      apiKey = `${KEY_SCHEME_PREFIX}${prefix}_${secret}`
      await runtime.query(
        `INSERT INTO api_keys (user_id, name, key_hash, prefix)
         VALUES ($1, $2, $3, $4)`,
        [userId, API_KEY_NAME, sha256(apiKey), prefix],
      )
    }

    await runtime.query('COMMIT')
    process.stdout.write(
      `seed: user=${DEV_EMAIL} memories +${inserted} (=${skipped} already present, ${backfilled} embeddings backfilled), supersedes edges +${edges}\n`,
    )
    if (apiKey) {
      process.stdout.write(
        `seed: API key (${API_KEY_NAME}) — save it now, shown once:\n${apiKey}\n`,
      )
    } else {
      process.stdout.write(`seed: API key (${API_KEY_NAME}) already present — not re-minted\n`)
    }
  } catch (error) {
    await runtime.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await owner.end()
    await runtime.end()
  }
}

main().catch((error) => {
  process.stderr.write(`seed failed: ${error.message}\n`)
  process.exitCode = 1
})
