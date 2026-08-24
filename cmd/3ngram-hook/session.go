// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Session-lifecycle client for the hook-facing REST surface shipped in step 5a
// (docs/concepts/session-continuity.mdx layers 1 and 6):
//
//	POST /api/v1/agent-sessions/open      SessionStart
//	POST /api/v1/agent-sessions/heartbeat Stop  (lease + last_assistant_message)
//	POST /api/v1/agent-sessions/close     SessionEnd
//
// NATURAL KEY, never a sessionRunId. Stop and SessionEnd are separate processes
// that hold the harness conversation id and nothing else, and the page forbids a
// local run-id mapping file — so every call addresses the row by
// `(agent, sessionId)` and the tenant comes from the API key.
//
// Every path here is fire-and-forget: a failure logs one line to stderr and the
// caller exits 0. These hooks must be invisible when the server is down.
//
// The two bounds this file enforces before building a body —
// maxSessionExcerptLength and maxBriefedMemories — are GENERATED from
// packages/schema into contract_gen.go. Nothing else from the Zod boundary is
// mirrored here: the server's parse is the single validator for shapes
// (AGENTS.md hard rule 2), and a Go copy of a regex or a uuid check would be a
// second boundary that can silently disagree with it.

// unknownAgent is the natural-key agent for a harness the binary cannot
// identify. Unlike a project facet — which is OMITTED rather than persisted as
// the literal "unknown" — `agent` is half of the row's identity and has no
// absent form, so an honest placeholder is the only option. Pass `--agent` (or
// THREENGRAM_AGENT) from the hook registration to name the harness exactly.
const unknownAgent = "unknown-agent"

// unknownAgentOnce keeps the placeholder diagnostic to one line per process.
// The hook runs on every session event; a banner per event would be noise.
var unknownAgentOnce sync.Once

// hookSuppressed is the filter every session-scoped hook shares: skip
// Task-dispatched sub-agents (THREENGRAM_HOOK_ROLE=subagent, which inherit the
// MAIN worktree cwd so the path check alone would not catch them) and skip
// secondary worktrees. Registering the lifecycle for those would open, lease and
// close rows for conversations that are not sessions.
func hookSuppressed(cwd string) bool {
	return os.Getenv("THREENGRAM_HOOK_ROLE") == "subagent" || isSecondaryWorktree(cwd)
}

// briefedMemory is one `{id, topic, status}` row of the SessionStart stamp. `id`
// is the commitment's MEMORY id — that is what `resolve` takes and what the
// debrief render tells the model to resolve.
type briefedMemory struct {
	ID     string `json:"id"`
	Topic  string `json:"topic"`
	Status string `json:"status"`
}

// agentSessionKey is the tenant-scoped address of one session row. user_id is
// not part of the wire contract; it comes from the API key.
type agentSessionKey struct {
	Agent     string `json:"agent"`
	SessionID string `json:"sessionId"`
}

type sessionOpenRequest struct {
	Agent     string           `json:"agent"`
	SessionID string           `json:"sessionId"`
	Source    string           `json:"source"`
	Project   string           `json:"project,omitempty"`
	Scope     string           `json:"scope,omitempty"`
	Selector  briefingSelector `json:"selector"`
	// POINTER so a startup that surfaced nothing still sends `[]`: the server
	// stamps briefing_delivered_at on PRESENCE of the key, and an empty briefing
	// is still a delivery. A plain slice with omitempty would drop it.
	BriefedMemories *[]briefedMemory `json:"briefedMemories,omitempty"`
}

type sessionOpenResponse struct {
	SessionRunID    string `json:"sessionRunId"`
	ActivationEpoch int    `json:"activationEpoch"`
	Created         bool   `json:"created"`
	Reopened        bool   `json:"reopened"`
}

type sessionHeartbeatRequest struct {
	Agent     string `json:"agent"`
	SessionID string `json:"sessionId"`
	// min(1) server-side: omitted rather than sent empty.
	LastMessageExcerpt string `json:"lastMessageExcerpt,omitempty"`
}

type sessionHeartbeatResponse struct {
	SessionRunID string `json:"sessionRunId"`
	Resurrected  bool   `json:"resurrected"`
}

// heartbeatOutcome distinguishes the THREE answers a heartbeat can give. The
// clear path turns a probe into a startup-or-resume decision, and "no row for
// this conversation id" is a different fact from "I could not ask": collapsing
// them would send `source=startup` after a timeout, which then 409s against a
// live row whose stored params differ and costs the session its reinjection.
type heartbeatOutcome int

const (
	// heartbeatFailed is the zero value ON PURPOSE: a result nobody filled in
	// must not read as an existence answer.
	heartbeatFailed heartbeatOutcome = iota
	// heartbeatOK — 200. The row exists and its lease was refreshed.
	heartbeatOK
	// heartbeatNoRow — a definitive 404. This tenant owns no row for the key.
	heartbeatNoRow
)

type heartbeatResult struct {
	outcome      heartbeatOutcome
	sessionRunID string
	// resurrected reports that the refresh revived a closed or lease-expired
	// row and advanced `activation_epoch`.
	resurrected bool
}

// deriveAgent resolves the harness name for the natural key.
//
// Precedence: an explicit `--agent` on the subcommand (what the Codex
// hooks.json registration carries), then THREENGRAM_AGENT, then the harness's
// own environment, then {@link unknownAgent}. The flag wins because a hook
// registration is the one place that knows for certain which harness will run
// the binary.
//
// An operator-supplied name is NORMALIZED (trim + lowercase, because
// agentNameSchema is kebab-case) but not VALIDATED. A name the server rejects
// is a loud 400 on the next call, which is the honest outcome: silently
// swapping in a detected harness would split one operator's sessions across two
// natural keys and look like the hook simply lost them.
func deriveAgent(args []string) string {
	if a := normalizeAgent(agentFlag(args)); a != "" {
		return a
	}
	if a := normalizeAgent(os.Getenv("THREENGRAM_AGENT")); a != "" {
		return a
	}
	if os.Getenv("CLAUDECODE") != "" || os.Getenv("CLAUDE_CODE_ENTRYPOINT") != "" {
		return "claude-code"
	}
	if os.Getenv("CODEX_HOME") != "" || os.Getenv("CODEX_SANDBOX") != "" {
		return "codex"
	}
	warnUnknownAgent()
	return unknownAgent
}

// warnUnknownAgent tells the operator, once, that their sessions are landing
// under a placeholder identity. Silence here is the worst outcome: the rows are
// written and leased correctly, so nothing looks broken until two harnesses
// share the placeholder and their runs interleave under one agent name.
func warnUnknownAgent() {
	unknownAgentOnce.Do(func() {
		fmt.Fprintf(stderrWriter,
			"3ngram-hook: harness not detected — session rows will use agent %q.\n"+
				"  Name it with --agent <harness> in your hook registration, or export THREENGRAM_AGENT.\n",
			unknownAgent)
	})
}

// agentFlag reads `--agent <name>` or `--agent=<name>` out of a subcommand's
// arguments. Unknown arguments are ignored — a hook must never fail a session
// over its own registration.
func agentFlag(args []string) string {
	for i, arg := range args {
		if value, ok := strings.CutPrefix(arg, "--agent="); ok {
			return value
		}
		if arg == "--agent" && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

// normalizeAgent trims and lowercases an operator-supplied name so it can
// satisfy the server's kebab-case rule. "" means "not supplied" — the only
// judgement this function makes; whether the rest is a legal agent name is the
// server's call.
func normalizeAgent(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}

// sessionOpen posts SessionStart and returns the sessionRunId the model is told
// to pass on writes. Returns "" on every failure path.
func sessionOpen(key agentSessionKey, source, project string, selector briefingSelector, briefed *[]briefedMemory) string {
	req := sessionOpenRequest{
		Agent:           key.Agent,
		SessionID:       key.SessionID,
		Source:          source,
		Selector:        selector,
		BriefedMemories: briefed,
	}
	// Never the literal "unknown" deriveProject returns for an empty cwd: a fake
	// facet on the row is indistinguishable from a real one.
	if project != "" && project != "unknown" {
		req.Project = project
	}
	// The scope facet comes off whichever selector axis carries one — including
	// a scope a retrieval policy NARROWED us to, which is the scope the agent
	// actually read. Whatever the value is, the briefing GET already accepted it.
	if selector.Scope != "" {
		req.Scope = selector.Scope
	}

	body, err := json.Marshal(req)
	if err != nil {
		return ""
	}
	respBody, status, err := apiRequest("POST", "/api/v1/agent-sessions/open", body, 3*time.Second)
	if err != nil || status >= 400 {
		logSessionFailure("agent-sessions/open", status, err)
		return ""
	}
	var resp sessionOpenResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return ""
	}
	return resp.SessionRunID
}

// sessionHeartbeat refreshes the lease by natural key, optionally snapshotting
// the turn's bounded last_assistant_message.
//
// A 404 is reported as {@link heartbeatNoRow} rather than as a failure: it is
// the definitive answer "this tenant owns no row for this conversation id",
// which is what the clear path needs. Everything else — transport error, 401,
// 5xx, malformed body — is {@link heartbeatFailed} and must never be read as an
// existence answer.
func sessionHeartbeat(key agentSessionKey, excerpt string, timeout time.Duration) heartbeatResult {
	body, err := json.Marshal(sessionHeartbeatRequest{
		Agent:              key.Agent,
		SessionID:          key.SessionID,
		LastMessageExcerpt: excerpt,
	})
	if err != nil {
		return heartbeatResult{}
	}
	respBody, status, err := apiRequest("POST", "/api/v1/agent-sessions/heartbeat", body, timeout)
	if err != nil {
		logSessionFailure("agent-sessions/heartbeat", status, err)
		return heartbeatResult{}
	}
	if status == http.StatusNotFound {
		return heartbeatResult{outcome: heartbeatNoRow}
	}
	if status >= 400 {
		logSessionFailure("agent-sessions/heartbeat", status, nil)
		return heartbeatResult{}
	}
	var resp sessionHeartbeatResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		logSessionFailure("agent-sessions/heartbeat", status, err)
		return heartbeatResult{}
	}
	if resp.Resurrected {
		// A refresh that revives a row bumps `activation_epoch` and invalidates
		// any closer claim fenced at the old one. That is correct and cheap, but
		// a call made to ASK a question should not mutate state invisibly.
		fmt.Fprintln(stderrWriter, "3ngram-hook: heartbeat resurrected a closed or lease-expired session row")
	}
	return heartbeatResult{
		outcome:      heartbeatOK,
		sessionRunID: resp.SessionRunID,
		resurrected:  resp.Resurrected,
	}
}

// sessionClose stamps closed_at by natural key. Correctness never depends on it
// (the lease plus the sweep do), so it gets one tight-timeout POST and nothing
// else — SessionEnd shares a 1.5s budget on Claude and 3s on Codex.
func sessionClose(key agentSessionKey, timeout time.Duration) {
	body, err := json.Marshal(key)
	if err != nil {
		return
	}
	_, status, err := apiRequest("POST", "/api/v1/agent-sessions/close", body, timeout)
	if err != nil || status >= 400 {
		logSessionFailure("agent-sessions/close", status, err)
	}
}

// logSessionFailure writes one bounded line to stderr. `route` is the REST path
// tail, so the operator can tell a briefing read apart from a lifecycle write.
// Route names and status codes only — no memory content, no briefing rows, no
// excerpt (hard rule 6).
func logSessionFailure(route string, status int, err error) {
	if err != nil {
		fmt.Fprintf(stderrWriter, "3ngram-hook: %s unreachable (%v)\n", route, err)
		return
	}
	fmt.Fprintf(stderrWriter, "3ngram-hook: %s returned %d\n", route, status)
}

// boundExcerpt trims and truncates last_assistant_message to the server's cap.
// The cut lands on a rune boundary: a byte-length cut is the SAFE direction
// against the server's UTF-16 bound (a multi-byte rune is never fewer bytes than
// UTF-16 units), but splitting one would ship a replacement character.
func boundExcerpt(message string) string {
	excerpt := strings.TrimSpace(message)
	if len(excerpt) <= maxSessionExcerptLength {
		return excerpt
	}
	return excerpt[:runeSafeCut(excerpt, maxSessionExcerptLength)]
}

// runeSafeCut returns the largest index <= n that does not split a UTF-8 rune.
func runeSafeCut(s string, n int) int {
	if n >= len(s) {
		return len(s)
	}
	if n <= 0 {
		return 0
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return n
}

// sessionRunInstruction is the model-mediated half of write-time provenance
// (layer 2, point 3): SessionStart injects the run id plus the instruction to
// pass it on writes. Attribution on the hooked path is best-effort — an agent
// that omits the field falls through to the server's single-open-session
// default — so the wording names the tools rather than assuming a transport.
func sessionRunInstruction(sessionRunID string) string {
	return fmt.Sprintf(
		"\n**3ngram session run**: `%s`\n"+
			"Pass `sessionRunId: \"%s\"` on every 3ngram `remember` / `revise` / `resolve` call in this session "+
			"so the writes are attributed to this run.",
		sessionRunID, sessionRunID,
	)
}
