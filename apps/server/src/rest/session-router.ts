// SPDX-License-Identifier: Apache-2.0
// Thin REST transports for the hook-facing session lifecycle
// (docs/concepts/session-continuity.mdx layers 1, 4 and 6). Authentication is
// mounted by restRouter before this child router; the lease arithmetic, the
// epoch fence and the locking stay in core/db — these routes validate, call,
// and shape ISO timestamps.
//
// NATURAL KEY, not sessionRunId. Stop and SessionEnd are separate processes
// holding the harness conversation id only, and the page forbids a local
// mapping file — so `(agent, sessionId)` rides the BODY (or the query, for the
// debrief render) and the tenant comes from the API key. Close carries no
// `activation_epoch` on purpose.
//
// Every body and query is parsed WHOLE through its strict schema, so an unknown
// or misspelled key is a 400 rather than a silently-ignored field (the same rule
// the session-events query rides). Logs stay ids and counts: `briefedMemories`
// topics and `lastMessageExcerpt` never enter one (hard rule 6).
import { loadSessionTriageConfig } from '@3ngram/config'
import {
  type AccessGate,
  beginAgentSessionTriage,
  closeAgentSession,
  completeAgentSessionTriage,
  getAgentSession,
  heartbeatAgentSession,
  openAgentSession,
  renderDebriefPrompt,
  type TriageDebounceThresholds,
} from '@3ngram/core'
import {
  agentSessionCloseBodySchema,
  agentSessionHeartbeatBodySchema,
  agentSessionOpenBodySchema,
  debriefPromptQuerySchema,
} from '@3ngram/schema'
import { Router } from 'express'
import { defined, guard, tenant } from './route-helpers.js'

export interface SessionRouterOptions {
  /** Access gate — asserts read/write access. Undefined → no guard (test/back-compat). */
  access?: AccessGate | undefined
  /**
   * Stop-nudge debounce floors. Undefined → resolved from the environment
   * (`loadSessionTriageConfig`). Injectable so a test pins the thresholds
   * instead of mutating process env, the same shape `access` uses.
   */
  triageThresholds?: TriageDebounceThresholds | undefined
}

export function sessionRouter(options: SessionRouterOptions): Router {
  const router = Router()

  // POST /api/v1/agent-sessions/open — SessionStart. Idempotent by the natural
  // key, which doubles as the request token: a duplicate `startup` delivery with
  // the same identity params changes nothing, one with CHANGED params is a 409.
  router.post('/api/v1/agent-sessions/open', (req, res) => {
    void guard('agent-sessions.open', res, async () => {
      const input = agentSessionOpenBodySchema.parse(req.body)
      // ACCESS GUARD: this WRITES tenant bookkeeping, so write access is
      // asserted before the row is touched (self-host allowAllAccess allows all).
      if (options.access) await options.access.assertWrite(tenant(req))
      const opened = await openAgentSession(tenant(req), input)
      res.status(200).json({
        sessionRunId: opened.row.id,
        activationEpoch: opened.row.activationEpoch,
        source: input.source,
        created: opened.created,
        reopened: opened.reopened,
        openedAt: opened.row.openedAt.toISOString(),
        lastSeenAt: opened.row.lastSeenAt.toISOString(),
        briefingDeliveredAt: opened.row.briefingDeliveredAt?.toISOString() ?? null,
      })
    })
  })

  // POST /api/v1/agent-sessions/close — SessionEnd. Sets `closed_at` by natural
  // key. Idempotent: a repeat close echoes the FIRST close's timestamp, which is
  // what keeps `closed_at <= last_seen_at + lease` identifying an explicit close.
  router.post('/api/v1/agent-sessions/close', (req, res) => {
    void guard('agent-sessions.close', res, async () => {
      const input = agentSessionCloseBodySchema.parse(req.body)
      if (options.access) await options.access.assertWrite(tenant(req))
      const closed = await closeAgentSession(tenant(req), input)
      res.status(200).json({
        sessionRunId: closed.row.id,
        activationEpoch: closed.row.activationEpoch,
        // Core's non-null `closedAt`, never a value invented from another
        // column: the close decision and the timestamp come from the same
        // row-locked read, so there is nothing left to guess.
        closedAt: closed.closedAt.toISOString(),
        alreadyClosed: closed.alreadyClosed,
      })
    })
  })

  // POST /api/v1/agent-sessions/heartbeat — Stop. Monotonic lease refresh that
  // resurrects a closed or lease-expired row, optionally snapshotting the turn's
  // bounded `last_assistant_message` for the closer.
  router.post('/api/v1/agent-sessions/heartbeat', (req, res) => {
    void guard('agent-sessions.heartbeat', res, async () => {
      const input = agentSessionHeartbeatBodySchema.parse(req.body)
      if (options.access) await options.access.assertWrite(tenant(req))
      const beat = await heartbeatAgentSession(tenant(req), input)
      res.status(200).json({
        sessionRunId: beat.row.id,
        activationEpoch: beat.row.activationEpoch,
        lastSeenAt: beat.row.lastSeenAt.toISOString(),
        resurrected: beat.resurrected,
      })
    })
  })

  // POST /api/v1/agent-sessions/triage/begin — Stop, first half. The SERVER
  // decides: it evaluates the entry rule (which triage_status may re-enter, and
  // on what signal) and the debounce, then answers `armed`. The hook injects the
  // debrief only when armed, so the rule is identical across harnesses — the
  // same division of labour that keeps 3ngram owning the words and the hook
  // owning the trigger.
  //
  // A DECLINE IS A 200, not an error: "no nudge this turn" is the expected
  // answer on most Stops, and `reason` is the content-free tag that says which
  // rule declined. Only an unknown natural key is a 404 — Stop never creates a
  // missing row, and a decline would hide a broken SessionStart.
  router.post('/api/v1/agent-sessions/triage/begin', (req, res) => {
    void guard('agent-sessions.triage.begin', res, async () => {
      // RAW BODY, NOT PRE-PARSED. `beginAgentSessionTriage` is THE validation
      // boundary and parses this once (hard rule 2), the same contract
      // `remember` has. A transport only re-parses when it must echo a
      // NORMALIZED value in the response — the `open` route does, to report
      // `source`; this response is built entirely from what core returns, so a
      // second parse would buy nothing and be a second boundary. A malformed
      // body still surfaces as 400: core's ZodError maps there.
      //
      // ACCESS GUARD: arming WRITES the row (status, attempt token, watermark).
      // It runs before the parse now, so an unauthorised caller sending junk
      // gets 403 rather than 400 — the right order anyway, since the shape of a
      // request they may not make is none of their business.
      if (options.access) await options.access.assertWrite(tenant(req))
      const begun = await beginAgentSessionTriage(tenant(req), req.body, {
        thresholds: options.triageThresholds ?? loadSessionTriageConfig(),
      })
      res.status(200).json(
        defined({
          sessionRunId: begun.sessionRunId,
          armed: begun.armed,
          attemptId: begun.attemptId,
          triageStatus: begun.triageStatus,
          reason: begun.reason,
        }),
      )
    })
  })

  // POST /api/v1/agent-sessions/triage/complete — Stop, second half. Absorbs the
  // continuation's writes: `completed` when it produced provenance, `expired`
  // when it produced none (so the closer still runs), `overflowed` past the
  // per-run ceiling — and stamps the CUMULATIVE watermark.
  //
  // A stale attempt is a 409, not a silent no-op: a crashed hook, a second Stop
  // or a closer that re-claimed the row after the lease expired mid-handshake
  // must learn that its attempt is over rather than retry forever.
  router.post('/api/v1/agent-sessions/triage/complete', (req, res) => {
    void guard('agent-sessions.triage.complete', res, async () => {
      // Raw body for the same reason `begin` passes raw: core parses once.
      if (options.access) await options.access.assertWrite(tenant(req))
      const done = await completeAgentSessionTriage(tenant(req), req.body)
      res.status(200).json({
        sessionRunId: done.sessionRunId,
        triageStatus: done.triageStatus,
        eventCount: done.eventCount,
        sinceBeginCount: done.sinceBeginCount,
        truncated: done.truncated,
      })
    })
  })

  // GET /api/v1/prompts/debrief — the MCP debrief registrar over REST. MCP
  // prompts are user-invoked and a server cannot push one, so the hook fetches
  // the text here and injects it as a Stop continuation. It renders THE SAME
  // function src/mcp/prompts.ts renders (packages/core/src/prompts/debrief.ts) — duplicating
  // the words into the hook would forfeit cross-harness parity.
  //
  // `agent` + `sessionId` name the run whose `briefed_memories` get inlined as
  // the id -> topic/status mapping: the shipped SessionStart briefing renders
  // topics and omits ids, so without the mapping the model cannot tell which of
  // several open commitments to resolve. Instructions are server-authored; the
  // facets and the briefed rows render as delimited data.
  router.get('/api/v1/prompts/debrief', (req, res) => {
    void guard('prompts.debrief', res, async () => {
      const query = debriefPromptQuerySchema.parse(req.query)
      // ACCESS GUARD: the briefed rows are tenant data (topics), so read access
      // is asserted BEFORE the read (self-host allowAllAccess allows all).
      if (options.access) await options.access.assertRead(tenant(req))
      const key =
        query.agent === undefined || query.sessionId === undefined
          ? undefined
          : { agent: query.agent, sessionId: query.sessionId }
      // An unknown natural key throws AgentSessionNotFoundError -> 404 rather
      // than rendering a prompt that quietly dropped the mapping it was asked
      // for — "resolve what you completed" with no ids is the failure the
      // mapping exists to fix.
      const session = key === undefined ? undefined : await getAgentSession(tenant(req), key)
      // THE ROW IS THE FALLBACK FOR BOTH FACETS, and that is a correctness fix
      // rather than a convenience. `agent_sessions.scope` records the EFFECTIVE
      // scope the run was briefed under — a tenant retrieval policy may have
      // narrowed a `kind=all` request to its default scope, and SessionStart
      // stamps whatever the briefing response echoed
      // (`cmd/3ngram-hook/briefing.go`). A caller that reconstructs the facet
      // from its own environment cannot know that narrowed name, so the prompt
      // would tell the model to file under a scope it was never briefed under —
      // and an omitted `scope` on `remember` defaults to `personal`, which drops
      // the debrief memories out of the very briefing that surfaced the work.
      // Same argument for `project`: the row holds the facet resolved at open.
      //
      // An EXPLICIT query value still wins. This route is not hook-only, and a
      // caller that names a facet is answering the question itself; the fallback
      // fires only where the answer was previously absent.
      res.status(200).json({
        prompt: renderDebriefPrompt(
          defined({
            scope: query.scope ?? session?.scope ?? undefined,
            project: query.project ?? session?.project ?? undefined,
            briefedCommitments: session?.briefedMemories,
          }),
        ),
      })
    })
  })

  return router
}
