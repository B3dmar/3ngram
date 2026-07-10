// SPDX-License-Identifier: Apache-2.0
// Pluggable LongMemEval retrievers: the lexical stand-in and the
// REAL Phase-1B retriever, behind one `rankSessions(question, sessions)`
// interface so every advisory slice (longmemeval.mjs, judge.mjs) goes through
// a single seam.
//
// ADVISORY ONLY: nothing here gates a PR. The deterministic lexical
// ranker (lib.mjs) is the DEFAULT and the only path PR-lane unit tests touch —
// it is network/DB/model-free. The REAL retriever is OPT-IN (--retriever=real
// or EVAL_RETRIEVER=real) and runs ONLY in the nightly advisory lane, which has
// the DB branch + embedding-gateway secret.
//
// REAL MODE (the product retrieval path, end to end):
//   1. Per question, a DISPOSABLE tenant is created (a fresh user). On the
//      shared Neon branch this keeps questions isolated and re-runs idempotent;
//      the ephemeral nightly branch is torn down at job end (no row survives a
//      run), so there is no destructive cleanup on a write path (hard rule 1).
//   2. Each haystack session is seeded as memory via the PRODUCT WRITE PATH
//      (core.remember with the injected real gateway), so the embedding lands
//      through embed-on-write exactly as production does. A session whose text
//      fits the rememberInputSchema content cap becomes ONE memory; a longer
//      session is CHUNKED at the cap and the session ranks by its BEST chunk.
//   3. The question is embedded via the real gateway and core.search() runs the
//      product fusion ({fts:0.2,recency:0,vector:1}); sessions rank by their
//      best-scoring memory hit.
//
// Observability (hard rule 6): NO session/memory/question CONTENT is ever
// logged — only ids, counts and lengths. The advisory metrics object carries
// ids/scores/counts only.
//
// LAYERING (hard rule 5): eval is a transport-like consumer. It calls
// core.remember / core.search (the policy surface) and db.insertUser (the
// pre-tenant admin helper) — it holds no business logic and never touches a
// pool directly.
import { randomUUID } from 'node:crypto'
import { rankSessions as rankSessionsLexical, sessionText } from './lib.mjs'

/** The default offline retriever name; the opt-in real path is 'real'. */
export const DEFAULT_RETRIEVER = 'lexical'

/** The only retriever names the advisory harness accepts. */
export const KNOWN_RETRIEVERS = Object.freeze(['lexical', 'real'])

/** Resolve the retriever name from a CLI flag value / env, defaulting to lexical. */
export function resolveRetrieverName(flagValue, env = process.env) {
  return flagValue ?? env.EVAL_RETRIEVER ?? DEFAULT_RETRIEVER
}

/**
 * Throw a clear error for any retriever name that is not lexical or real. An
 * unknown value must NEVER silently fall back to lexical: that is the same
 * silent metric misattribution the equals-form fix closes (issue #122).
 */
export function assertKnownRetriever(name) {
  if (!KNOWN_RETRIEVERS.includes(name)) {
    throw new Error(
      `unknown retriever: ${JSON.stringify(name)} (expected one of: ${KNOWN_RETRIEVERS.join(', ')})`,
    )
  }
}

/**
 * True when `error` is core's DuplicateMemoryError. Matched by the stable
 * `name`/`contentHash` contract (not `instanceof`) so the default lexical/unit
 * path never has to statically load `@3ngram/core`.
 */
export function isDuplicateMemoryError(error) {
  return (
    error instanceof Error &&
    error.name === 'DuplicateMemoryError' &&
    typeof error.contentHash === 'string'
  )
}

/**
 * Split a session's text into <= maxLen-char chunks on a UTF-16 code-unit
 * boundary (the same unit rememberInputSchema.max() counts). One memory per
 * chunk; the session ranks by its best chunk. Trimmed-empty chunks are dropped
 * because the write contract requires non-empty content.
 */
export function chunkSessionText(text, maxLen) {
  const chunks = []
  for (let i = 0; i < text.length; i += maxLen) {
    const slice = text.slice(i, i + maxLen).trim()
    if (slice.length > 0) chunks.push(slice)
  }
  return chunks.length > 0 ? chunks : ['']
}

/**
 * Build the per-session memory write payloads for one question. Returns a flat
 * list of `{ session_id, content }` — one entry per chunk, so a session can map
 * to several memories. `maxLen` is the rememberInputSchema content cap.
 */
export function planSessionMemories(sessions, maxLen) {
  const plan = []
  for (const session of sessions) {
    const text = sessionText(session).trim()
    const chunks = text.length <= maxLen ? [text] : chunkSessionText(text, maxLen)
    for (const content of chunks) {
      if (content.length > 0) plan.push({ session_id: session.session_id, content })
    }
  }
  return plan
}

/**
 * Rank sessions by their best memory hit from a flat list of search hits.
 * `hitsByMemoryId` maps a memory id -> { session_id, score }; the session score
 * is the MAX over its memories' scores (best chunk wins). Sessions with no hit
 * score 0. Sorted by score desc, ties broken by session_id — the SAME contract
 * the lexical ranker exposes, so downstream scoring is identical in shape.
 */
export function rankSessionsFromHits(sessionIds, memoryToSession, hits) {
  const best = new Map(sessionIds.map((id) => [id, 0]))
  for (const hit of hits) {
    const sessionId = memoryToSession.get(hit.id)
    if (sessionId === undefined) continue
    const prior = best.get(sessionId) ?? 0
    if (hit.score > prior) best.set(sessionId, hit.score)
  }
  return [...best.entries()]
    .map(([session_id, score]) => ({ session_id, score }))
    .sort((a, b) => b.score - a.score || a.session_id.localeCompare(b.session_id))
}

/**
 * The lexical retriever: a thin wrapper around lib.rankSessions so both
 * retrievers share one `{ name, rankSessions }` shape. Pure, offline, the
 * default. `--retriever=lexical` output is byte-identical to the pre-swap
 * harness (regression guard).
 */
export const lexicalRetriever = {
  name: 'lexical',
  // eslint-disable-next-line require-await -- uniform async interface with real
  async rankSessions(question, sessions) {
    return rankSessionsLexical(question, sessions)
  },
}

/**
 * Construct the REAL retriever from injected product primitives. Dependency
 * injection is the whole point: offline plumbing tests pass fakes (a FakeGateway
 * + in-memory search/remember stubs) so `pnpm test` stays network/DB-free, while
 * the nightly lane passes the real core.remember / core.search / db.insertUser
 * wired to Postgres + the OpenAI-compatible gateway.
 *
 * Required deps:
 *   - remember(userId, input, actorKind, { gateway }) -> { embed: { settled } }
 *   - search(userId, query, { gateway }) -> SearchHit[] (with .id, .score)
 *   - makeTenant() -> Promise<userId>  (disposable per question)
 *   - gateway: the embedding Gateway (real or fake)
 *   - maxContentLength: rememberInputSchema content cap (chunk boundary)
 *   - limit: search window (defaults to a wide window so best-chunk ranking has
 *     every session's strongest hit available)
 *
 * Duplicate chunks: two haystack sessions can yield byte-identical trimmed
 * chunks (e.g. shared boilerplate). The product write path enforces ONE active
 * memory per (tenant, content_hash), so the second remember() throws
 * DuplicateMemoryError. We tolerate it: the first writer's memory id is recorded
 * keyed by its content, and a later duplicate reuses that SAME memory id. Tie
 * behaviour: a chunk shared by sessions A and B is a single physical memory, so
 * its search hit can only attribute to ONE session — we keep the FIRST writer
 * (the earlier session in plan order, which mirrors haystack order). The losing
 * session still ranks on its OTHER (non-duplicate) chunks; only a session whose
 * ENTIRE content is a duplicate of an earlier one forfeits that shared score to
 * the first. This is an advisory-lane bias, not a correctness gate,
 * and never throws — every session stays rankable.
 *
 * Detection is by the error's `name`/`contentHash` contract rather than an
 * `instanceof` against a static `@3ngram/core` import: keeping the import lazy
 * preserves the build-free, zero-network default lexical/unit path (the same
 * reason createRealRetrieverFromEnv uses dynamic imports below).
 */
export function createRealRetriever({
  remember,
  search,
  makeTenant,
  gateway,
  maxContentLength,
  actorKind = 'system',
}) {
  return {
    name: 'real',
    async rankSessions(question, sessions) {
      const userId = await makeTenant()
      const plan = planSessionMemories(sessions, maxContentLength)
      const memoryToSession = new Map()
      // content -> the FIRST writer's memory id, so a duplicate chunk reuses the
      // existing memory instead of double-writing (and instead of throwing).
      const contentToMemoryId = new Map()
      for (const { session_id, content } of plan) {
        const priorMemoryId = contentToMemoryId.get(content)
        if (priorMemoryId !== undefined) {
          // Already written by an earlier session: reuse, keep first attribution.
          continue
        }
        let written
        try {
          written = await remember(
            userId,
            {
              memoryType: 'note',
              topic: `lme-${session_id}`.slice(0, 256),
              content,
            },
            actorKind,
            { gateway },
          )
        } catch (error) {
          // A duplicate that wasn't seen in THIS run's content map (defensive:
          // e.g. a pre-seeded row on the shared branch). The tenant is fresh per
          // question, so this is rare, but never let it abort ranking. We have no
          // memory id for it, so the shared chunk simply doesn't attribute a hit —
          // the session still ranks on its other chunks.
          if (isDuplicateMemoryError(error)) continue
          throw error
        }
        // Block on embed-on-write so the vector is queryable before search.
        await written.embed.settled
        memoryToSession.set(written.id, session_id)
        contentToMemoryId.set(content, written.id)
      }
      // Wide window: every session's best chunk must be reachable for ranking.
      const hits = await search(userId, question, { gateway }, { limit: plan.length || 1 })
      const sessionIds = sessions.map((s) => s.session_id)
      return rankSessionsFromHits(sessionIds, memoryToSession, hits)
    },
  }
}

/**
 * Wire the REAL retriever from the built workspace packages + env. Lazy dynamic
 * imports of @3ngram/core / @3ngram/db / @3ngram/llm keep the default lexical
 * path free of any workspace-build or network coupling: this is only reached on
 * the opt-in real path. Returns null with a clear reason when the DB or the
 * embedding-gateway secret is absent, so the nightly real lane SKIPS cleanly
 * (clear log, exit 0) instead of failing — never a silent dependency.
 */
export async function createRealRetrieverFromEnv(env = process.env) {
  if (!env.DATABASE_URL) {
    return { retriever: null, skipReason: 'DATABASE_URL not set' }
  }
  if (!env.LLM_GATEWAY_API_KEY) {
    return { retriever: null, skipReason: 'LLM_GATEWAY_API_KEY not set' }
  }
  const [{ remember, search }, { insertUser }, { createOpenAIGateway }, { MAX_CONTENT_LENGTH }] =
    await Promise.all([
      import('@3ngram/core'),
      import('@3ngram/db'),
      import('@3ngram/llm'),
      import('@3ngram/schema'),
    ])
  // `||` (not `??`): CI exports the URL from an optional secret, so an unset
  // secret arrives as '' — treat empty string as unset, fall back to OpenAI.
  const baseUrl = env.LLM_GATEWAY_URL || 'https://api.openai.com/v1'
  const gateway = createOpenAIGateway({ baseUrl, apiKey: env.LLM_GATEWAY_API_KEY })
  const makeTenant = async () => {
    const user = await insertUser(`eval-lme-${randomUUID()}@eval.local`, 'x')
    return user.id
  }
  const retriever = createRealRetriever({
    remember,
    search,
    makeTenant,
    gateway,
    maxContentLength: MAX_CONTENT_LENGTH,
  })
  return { retriever, skipReason: null }
}

/**
 * Resolve a retriever by name. 'lexical' is always available (offline default).
 * 'real' wires from env and may return a skip (DB/secret absent) the caller
 * surfaces as a clean exit-0 skip.
 */
export async function resolveRetriever(name, env = process.env) {
  assertKnownRetriever(name)
  if (name === 'real') return createRealRetrieverFromEnv(env)
  return { retriever: lexicalRetriever, skipReason: null }
}
