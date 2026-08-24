// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

// The gated Stop nudge (docs/concepts/session-continuity.mdx layer 4, "Stop is a
// nudge"; issue #166 step 7b). It consumes the step-7a handshake:
//
//	POST /api/v1/agent-sessions/triage/begin     arm-or-decline, natural key
//	POST /api/v1/agent-sessions/triage/complete  absorb, fenced on the attempt id
//	GET  /api/v1/prompts/debrief                 the words, server-authored
//
// THE SERVER DECIDES, THE HOOK OBEYS. The entry rule, the debounce and the
// re-arm signal all live behind `begin`, so the trigger is identical on every
// harness. This file owns three things and nothing else: whether to ask, which
// envelope the current harness understands, and never emitting a blank one.
//
// DEFAULT-OFF. Without THREENGRAM_STOP_NUDGE=1 none of this runs and `stop` is
// byte-for-byte the heartbeat-only Stop of step 5b. That is the page's "one
// project, one harness, default-off" rollout, and it is not a config
// convenience: an ungated blocking Stop on a harness with no continuation cap
// is an infinite turn loop, not merely an annoying one.

const (
	// stopNudgeEnvVar gates the whole file. Strictly "1", the same spelling
	// THREENGRAM_PRECHECK_DISABLE and THREENGRAM_HOOK_DEBUG already use — a
	// safety flag should not be satisfiable by accident.
	stopNudgeEnvVar = "THREENGRAM_STOP_NUDGE"

	// Timeouts. This runs on EVERY Stop, so the armed path — the only one that
	// makes all three calls — must still fit a per-hook budget a user would
	// plausibly set. 3 x 2s on top of the 2s heartbeat is 8s worst case, which
	// is why the README raises the Stop registration to `"timeout": 10` when the
	// nudge is enabled. Every one of them fails to exit 0, never to a block.
	triageBeginTimeout    = 2 * time.Second
	triageCompleteTimeout = 2 * time.Second
	debriefPromptTimeout  = 2 * time.Second

	// triageReasonPending is the one decline reason the hook BRANCHES on. The
	// other six (`not-live`, `terminal`, `pending-fresh`, `no-signal`,
	// `debounce`, `overflowed`) are all "no nudge this turn" and need no local
	// vocabulary — mirroring the full enum here would be a second boundary that
	// can drift from triageDeclineReasonSchema for no gain. `pending-fresh` in
	// particular needs none: it carries no `attemptId`, so the finalize it
	// declines to authorize is unreachable whether the hook knows the word or
	// not, and an older hook against a newer server behaves identically.
	triageReasonPending = "pending"

	// claudeCodeAgent / codexAgent are the two harnesses with a REGISTERED
	// envelope. Anything else falls back to the portable shape (see
	// continuationEnvelope).
	claudeCodeAgent = "claude-code"
	codexAgent      = "codex"

	// nudgeSystemMessage names 3ngram as the source of the continuation, so a
	// user who suddenly sees their turn continue knows what did it and which
	// flag turns it off. `systemMessage` is a UNIVERSAL Stop field on Claude
	// Code; Codex has no `hookSpecificOutput` and no extras on Stop, so it never
	// carries this.
	nudgeSystemMessage = "3ngram: debrief nudge (THREENGRAM_STOP_NUDGE=1)"
)

// maxInjectionsPerAttempt is the numeric self-cap, and the whole point is WHERE
// the count lives.
//
// THE PROBLEM. Each Stop is a fresh process, and the page forbids a local state
// file, so the hook cannot keep a counter. It needs one anyway: Codex has no
// built-in continuation cap at all (openai/codex#37937), Claude's eight-block
// override is configurable (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP), and
// `stop_hook_active` can fail to propagate on Claude
// (anthropics/claude-code#54360) and is hardcoded false on Gemini CLI 0.30.0
// (gemini-cli#20426). A cap that depends on the harness's loop guard is a cap
// that is not there on exactly the harnesses that need one.
//
// THE COUNT IS THE SERVER'S `pending` STATE. `begin` arms EXACTLY ONCE per
// attempt: it flips `idle` -> `pending` and mints the attempt id, and while the
// row is `pending` every later `begin` answers `armed=false, reason=pending`.
// The hook injects only on `armed=true`. So injections-per-attempt <= 1 by
// construction, enforced by a single row in Postgres rather than by a counter
// this process cannot hold.
//
// DOES THE PROPERTY ACTUALLY BOUND THE LOOP? Walk the worst harness — one that
// never sets `stop_hook_active`, so the hook's own `stop_hook_active` branch is
// dead code and cannot help:
//
//	Stop 1  begin -> armed, attempt A   -> inject. Row is now `pending`.
//	Stop 2  begin -> decline `pending`, attempt A -> complete(A). NO injection.
//	         The continuation wrote something -> `completed`; wrote nothing ->
//	         `expired`. Either way `complete` stamps the CUMULATIVE watermark:
//	         every event id visible for the run right now, the debrief's own
//	         writes included.
//	Stop 3  begin -> `no-signal` (completed/expired with no event id outside the
//	         watermark) -> no injection. Terminates here.
//
// Both branches terminate, and they terminate for different reasons — a
// zero-write continuation cannot re-arm because nothing new exists, and a
// productive one cannot re-arm on its OWN writes because `complete` absorbed
// them. There is no path on which one turn produces two injections.
//
// THE RESIDUAL RISK, STATED HONESTLY. Re-arming needs a provenance event whose
// id is not in the watermark — genuinely new work by the entry rules. Two ways
// that can happen faster than a human working:
//
//  1. A write that COMMITS after `complete` took its listing. Its id is outside
//     the watermark, so the next Stop arms again. MCP writes are synchronous —
//     the model has the tool result before the turn ends, so the write is
//     committed before Stop fires — which leaves genuinely concurrent async
//     writers as the window. Bounded, not zero.
//  2. A user who keeps working on a harness with no loop guard. Each cycle
//     still costs one arm, one injection and one complete, so the ceiling is
//     ONE nudge per turn that produced new provenance. That is the honest
//     bound: not "never twice in a session", but "never twice for the same
//     work", and never an unbounded intra-turn loop.
//
// Neither hole is closable from the hook without the local state file the page
// rules out, and neither is a runaway: the cost is an extra turn, which is the
// quantity the validation bar measures.
const maxInjectionsPerAttempt = 1

// stopNudgeEnabled reports the flag. Absent or anything other than "1" leaves
// Stop heartbeat-only.
func stopNudgeEnabled() bool {
	return os.Getenv(stopNudgeEnvVar) == "1"
}

type triageBeginRequest struct {
	Agent     string `json:"agent"`
	SessionID string `json:"sessionId"`
	// StopHookActive forwards the harness's own flag so the SERVER can tell a
	// finalize-only delivery from a sibling racing the delivery that armed. It
	// exempts the attempt-age guard, which is what stops a short turn's finalize
	// being deferred into the next turn's watermark (issue #188). It is not a
	// permission to inject — this hook never injects on such a Stop.
	//
	// OMITTED WHEN FALSE, deliberately. The begin body is a `.strict()` Zod
	// object, so a field an older server does not know is a 400, not an ignored
	// extra. Sending it only on the finalize path keeps the ordinary path — the
	// one that arms and injects — wire-compatible with any 7a server, and leaves
	// the finalize path degrading to exactly today's deferral if the server is
	// older than the flag.
	StopHookActive bool `json:"stopHookActive,omitempty"`
	// TURN COUNT IS DELIBERATELY ABSENT. `turnCount` is a hint the server
	// cannot observe for itself, and neither harness puts one in the Stop
	// payload: Claude Code sends session_id / transcript_path / cwd /
	// hook_event_name / stop_hook_active / last_assistant_message, and Codex the
	// same shape. The only local source would be counting entries in
	// `transcript_path`, which the page rejects outright ("Codex: transcript
	// format is not a stable hook interface"). Omitting it costs nothing: the
	// debounce is a disjunction, and its other two arms — elapsed time since
	// `opened_at`, and an untriaged provenance event — are both server-side
	// facts. The CONDITION is not optional; which arm satisfies it is.
}

// triageBeginResponse is the arm-or-decline verdict. Only the fields the hook
// acts on are decoded; `sessionRunId` and `triageStatus` come back too and are
// deliberately ignored — Stop has no use for a run id it must not persist.
type triageBeginResponse struct {
	Armed bool `json:"armed"`
	// AttemptID is present when this call ARMED, and also on the `pending`
	// decline where it names the attempt already in flight. Absent on every
	// other decline: there is no attempt to finish, or — on `pending-fresh` —
	// none this process is authorized to finish yet.
	AttemptID string `json:"attemptId"`
	Reason    string `json:"reason"`
}

type triageCompleteRequest struct {
	Agent     string `json:"agent"`
	SessionID string `json:"sessionId"`
	AttemptID string `json:"attemptId"`
}

// debriefPrompt is the render. One bounded string, injected VERBATIM.
type debriefPrompt struct {
	Prompt string `json:"prompt"`
}

// stopDecision is the continuation envelope. Top-level `decision` / `reason` on
// BOTH harnesses — never `hookSpecificOutput.additionalContext`, which is a
// SessionStart / PreToolUse / PostToolUse field and is not a Stop field at all.
//
// Field order is the wire order (encoding/json marshals in declaration order),
// so the golden JSON in the tests pins the shape byte for byte.
type stopDecision struct {
	Decision string `json:"decision"`
	// Reason is the continuation input: Claude feeds it back to the model, Codex
	// turns it into a new user prompt. It is the server's text UNMODIFIED — see
	// runStopNudge.
	Reason string `json:"reason"`
	// SystemMessage is a Claude-only universal Stop field. Codex has no extras
	// on Stop, so the tag is omitted there rather than sent and ignored.
	SystemMessage string `json:"systemMessage,omitempty"`
}

// runStopNudge is the flag-gated half of the Stop hook. It returns the process
// exit code, which is 0 on every path — a nudge that can fail a turn is a worse
// bug than a nudge that never fires.
//
// The three-way split is the page's, exactly:
//
//	stop_hook_active=true   FINALIZE ONLY, never inject
//	begin declines          exit silently (`complete` first if an attempt exists)
//	begin arms              fetch the words, emit the envelope
func runStopNudge(key agentSessionKey, input stopInput) int {
	// `stop_hook_active=true` means a previous Stop already blocked this turn.
	// The page is unambiguous: it "never injects a new prompt; it only finalizes
	// or expires". This branch is a BELT, not the cap — the cap is the server's
	// `pending` state (see maxInjectionsPerAttempt), which is what keeps the
	// property on the harnesses that never set this field.
	if input.StopHookActive {
		finalizeTriage(key)
		return 0
	}

	// `false` is not a formality here: this is the delivery that can ARM and
	// INJECT, so it is exactly the delivery whose siblings must stay age-guarded.
	begun, ok := triageBegin(key, false)
	if !ok {
		// Server down, unknown natural key (Stop never creates a missing row),
		// or an unparseable body. Nothing to inject and nothing to finish.
		return 0
	}

	// THE SELF-CAP IN ONE BRANCH. An attempt is already in flight for this run,
	// so this Stop is the finalize of the injection a previous one made — even
	// on a harness that never set `stop_hook_active` to tell us so. Finalizing
	// on an ordinary Stop is the page's own rule: "a later ordinary Stop that
	// finds triage_status=pending applies the same complete-or-expire rule and
	// does not inject again".
	//
	// THE CONCURRENT-STOP RACE IS GUARDED ON THE SERVER (issue #188), and this
	// branch is deliberately unaware of how. If two processes handle ONE Stop
	// concurrently — what a duplicate registration of `stop` and its
	// `heartbeat` alias produces, since a harness runs every matching hook for
	// an event in parallel — process A can arm and still be fetching the prompt
	// while process B lands here. B must NOT finalize A's attempt: A injects
	// anyway, and the continuation's writes would commit outside the watermark
	// B stamped, so a later Stop would re-arm and one turn's work would draw
	// two nudges.
	//
	// `begin` decides that, by AGE: an attempt younger than the server's floor
	// declines `pending-fresh` and carries no `attemptId`, so there is nothing
	// here to finalize and completeTriage below is a no-op. The threshold, the
	// clock and the arm timestamp all stay server-side — the hook holds no
	// duplicate of a rule that must be identical on every harness, exactly as
	// it holds no copy of the entry rule or the debounce.
	if begun.Reason == triageReasonPending {
		completeTriage(key, begun.AttemptID)
		return 0
	}

	if !begun.Armed {
		return 0
	}

	prompt, ok := fetchDebriefPrompt(key)
	if !ok || strings.TrimSpace(prompt) == "" {
		// A BLANK `reason` IS A HOOK FAILURE on Codex, and a content-free block
		// on Claude is just a wasted turn. Decline to inject and hand the
		// attempt back: `complete` with no writes since begin lands the row on
		// `expired`, which is closer-eligible — so the debrief still happens,
		// off the interactive turn, which is where the page wanted it anyway.
		completeTriage(key, begun.AttemptID)
		return 0
	}

	envelope, err := continuationEnvelope(key.Agent, prompt)
	if err != nil {
		completeTriage(key, begun.AttemptID)
		return 0
	}
	fmt.Println(string(envelope))
	return 0
}

// finalizeTriage closes out the attempt this turn's injection armed, WITHOUT a
// local state file.
//
// Stop is a fresh process every time, so the attempt id from the arming Stop is
// gone. It round-trips through the SERVER instead: `begin` is idempotent for a
// pending attempt and hands the existing `attemptId` back on its `pending`
// decline, which is the only route that publishes it. There is no read-only way
// to ask (no natural-key GET on the row), so the finalize path necessarily
// calls a route that COULD arm.
//
// That "could" is the one wrinkle, and it is handled rather than assumed away.
// If `begin` unexpectedly ARMS here — the row was not pending, and new
// provenance plus the debounce admitted it — the hook still must not inject,
// because `stop_hook_active=true` forbids it. Leaving the fresh attempt in
// flight would strand it until some later Stop, so it is completed immediately:
// with no writes since a begin stamp taken moments ago the row lands on
// `expired`, which is unconditionally closer-eligible. The nudge is lost; the
// debrief is not.
//
// Any other decline (`not-live`, `no-signal`, `debounce`, `terminal`) carries no
// attempt id, which is the honest answer "nothing was armed, or the closer took
// the row over" — the hook does nothing.
//
// `pending-fresh` should NOT reach here any more: this path sends
// `stopHookActive=true`, which exempts the server's attempt-age guard, so a
// short turn's finalize lands on the turn that produced it rather than being
// deferred into the next one's watermark. It can still reach here on a server
// older than the flag (the strict body 400s, so `ok` is false and nothing
// happens) or on a harness that never sets `stop_hook_active` — Codex has no
// such field and Gemini CLI 0.30.0 hardcodes it false — and there the finalize
// is DEFERRED rather than lost: the row stays `pending`, so no later `begin` can
// arm a second injection, the next Stop past the floor completes it, and a
// session that ends first is unconditionally closer-eligible while `pending`.
func finalizeTriage(key agentSessionKey) {
	// `true` tells the server this is a finalize-only delivery, which exempts the
	// attempt-age guard: the harness set the flag because it already blocked on a
	// previous Stop for this turn, so this caller is the continuation of that
	// attempt rather than a sibling racing it.
	begun, ok := triageBegin(key, true)
	if !ok {
		return
	}
	completeTriage(key, begun.AttemptID)
}

// completeTriage posts the absorb, fenced on the attempt id. An empty id means
// there is nothing in flight and no call is made — `complete` requires a uuid
// and would 400.
func completeTriage(key agentSessionKey, attemptID string) {
	if attemptID == "" {
		return
	}
	body, err := json.Marshal(triageCompleteRequest{
		Agent:     key.Agent,
		SessionID: key.SessionID,
		AttemptID: attemptID,
	})
	if err != nil {
		return
	}
	// A 409 is EXPECTED here, not a bug: a stale attempt (a crashed hook, a
	// duplicate delivery, or a closer that re-claimed the row after the lease
	// expired mid-handshake) must learn its attempt is over. It logs like any
	// other non-2xx and the hook exits 0.
	_, status, err := apiRequest("POST", "/api/v1/agent-sessions/triage/complete", body, triageCompleteTimeout)
	if err != nil || status >= 400 {
		logSessionFailure("agent-sessions/triage/complete", status, err)
	}
}

// triageBegin asks the server whether to nudge. The bool is "I got an answer",
// which is NOT the same as "arm": a decline is a 200 with `armed:false`, and
// only a transport failure, a non-2xx or an unparseable body is `false` here.
func triageBegin(key agentSessionKey, stopHookActive bool) (triageBeginResponse, bool) {
	body, err := json.Marshal(triageBeginRequest{
		Agent:          key.Agent,
		SessionID:      key.SessionID,
		StopHookActive: stopHookActive,
	})
	if err != nil {
		return triageBeginResponse{}, false
	}
	respBody, status, err := apiRequest("POST", "/api/v1/agent-sessions/triage/begin", body, triageBeginTimeout)
	if err != nil || status >= 400 {
		logSessionFailure("agent-sessions/triage/begin", status, err)
		return triageBeginResponse{}, false
	}
	var resp triageBeginResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		logSessionFailure("agent-sessions/triage/begin", status, err)
		return triageBeginResponse{}, false
	}
	return resp, true
}

// fetchDebriefPrompt renders the words for this run.
//
// THE NATURAL KEY IS THE WHOLE REQUEST, deliberately. `agent` + `sessionId`
// inline the run's `briefed_memories` as the id -> topic/status mapping — the
// SessionStart briefing renders topics and omits ids, so without the mapping the
// model cannot tell which of several open commitments to resolve — and they are
// ALSO how the server resolves the `scope` and `project` facets, from the row.
//
// The hook used to send those facets itself, rebuilt from THREENGRAM_SCOPE and
// the cwd. That was wrong, and subtly: when SessionStart asks for a `kind=all`
// briefing and a tenant retrieval policy narrows it to a default scope,
// `fetchBriefing` records the EFFECTIVE scope on the row while
// THREENGRAM_SCOPE stays unset. The prompt would then omit the one name the
// model cannot infer, and an omitted `scope` on `remember` defaults to
// `personal` — filing the debrief outside the scope whose briefing surfaced the
// work, where the next scoped briefing will not find it. The row knows the
// answer; the environment only knows what this shell was told.
func fetchDebriefPrompt(key agentSessionKey) (string, bool) {
	query := url.Values{}
	query.Set("agent", key.Agent)
	query.Set("sessionId", key.SessionID)

	body, status, err := apiRequest("GET", "/api/v1/prompts/debrief?"+query.Encode(), nil, debriefPromptTimeout)
	if err != nil || status >= 400 {
		logSessionFailure("prompts/debrief", status, err)
		return "", false
	}
	var resp debriefPrompt
	if err := json.Unmarshal(body, &resp); err != nil {
		logSessionFailure("prompts/debrief", status, err)
		return "", false
	}
	return resp.Prompt, true
}

// continuationEnvelope builds the harness's blocking Stop output. This is the
// ONE place either envelope is constructed, so switching shapes is a local edit.
//
// INJECTION SAFETY. `prompt` is server-authored text whose caller-supplied and
// tenant-supplied values are already fenced as delimited JSON data
// (packages/core/src/prompts/debrief.ts). The hook passes it through VERBATIM —
// no trimming, no wrapping, no prefix — because any local edit would be a second
// author of a string whose defenses were designed as a whole. `encoding/json`
// does the escaping: the text carries newlines and backtick runs by
// construction, and they must survive as data inside one JSON string.
//
// WHICH CLAUDE SHAPE, AND WHY (resolved 2026-08-23). The two primary sources
// disagree, so both are recorded rather than one being quietly picked:
//
//   - anthropics/claude-code, the `ralph-wiggum` plugin's `stop-hook.sh` AT HEAD
//     emits exactly `{"decision":"block","reason":…,"systemMessage":…}`. It is
//     first-party and currently shipped, so that form provably works on the
//     builds users are running.
//   - The official hooks reference (`code.claude.com/docs/en/hooks`) documents
//     Stop's decision control as `continueConversation` with `"allow"`/`"deny"`
//     ("deny blocks the stop and continues the conversation"), plus the
//     universal `continue` / `systemMessage` / `additionalContext`. It no longer
//     documents `decision` for Stop at all.
//
// We emit the WORKING ARTIFACT, not the documented interface: a nudge that a
// current binary ignores is worse than one shaped like last quarter's docs, and
// the docs page has been unstable across repeated fetches. Both forms are NEVER
// emitted together — their interaction is undefined.
//
// TO SWITCH, if a build stops honouring this: give stopDecision the
// `hookSpecificOutput.hookEventName="Stop"` + `continueConversation:"deny"`
// shape and pass the text as `additionalContext`. That is a two-line change here
// plus the golden JSON in nudge_test.go, and nothing else in the hook moves.
// The alternate blocking path documented on BOTH harnesses — exit code 2 with
// the text on stderr — is the fallback of last resort; it is not primary because
// stderr text handling is cruder than a JSON field. See the README's validation
// checkpoint: enable the flag once and confirm a Stop actually continues the
// turn before relying on the nudge.
//
// CODEX IS NOT IN QUESTION. `{"decision":"block","reason"}` is verified against
// Codex's generated hook schemas (`codex-rs/hooks/src/events/stop.rs`), where a
// blank `reason` is a hook failure rather than a no-op.
//
// An unregistered harness gets the portable subset — the intersection of the
// two — so it cannot be wrong in a way the Codex envelope is not already wrong.
// Registration is still a per-harness decision the README gates: Cursor takes
// `followup_message` and must NOT be sent `decision`/`reason` at all.
func continuationEnvelope(agent, prompt string) ([]byte, error) {
	envelope := stopDecision{Decision: "block", Reason: prompt}
	if agent == claudeCodeAgent {
		envelope.SystemMessage = nudgeSystemMessage
	}
	return json.Marshal(envelope)
}
