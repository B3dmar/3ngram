// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
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

// maxSessionExcerptLength mirrors MAX_SESSION_EXCERPT_LENGTH
// (packages/schema/src/agent-sessions.ts). The server 400s a longer excerpt
// rather than deciding which half of an agent's message matters, so the hook
// truncates locally instead of relying on that rejection.
const maxSessionExcerptLength = 4000

// maxBriefedMemories / maxBriefedTopic / maxBriefedStatus mirror
// MAX_BRIEFED_MEMORIES and the briefedMemorySchema field bounds. Over-long rows
// would 400 the whole open and cost the session its sessionRunId, so the hook
// drops or trims them here.
const (
	maxBriefedMemories = 100
	maxBriefedTopic    = 256
	maxBriefedStatus   = 64
)

// agentNamePattern mirrors agentNameSchema: kebab-case, lowercase alphanumerics
// and hyphens, leading alphanumeric.
var agentNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// unknownAgent is the natural-key agent for a harness the binary cannot
// identify. Unlike a project facet — which is OMITTED rather than persisted as
// the literal "unknown" — `agent` is half of the row's identity and has no
// absent form, so an honest placeholder is the only option. Pass `--agent` (or
// THREENGRAM_AGENT) from the hook registration to name the harness exactly.
const unknownAgent = "unknown-agent"

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
}

// deriveAgent resolves the harness name for the natural key.
//
// Precedence: an explicit `--agent` on the subcommand (what the Codex
// hooks.json registration carries), then THREENGRAM_AGENT, then the harness's
// own environment, then {@link unknownAgent}. The flag wins because a hook
// registration is the one place that knows for certain which harness will run
// the binary.
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
	return unknownAgent
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

// normalizeAgent lowercases and validates against agentNameSchema, returning ""
// for anything the server would reject.
func normalizeAgent(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" || len(value) > 64 || !agentNamePattern.MatchString(value) {
		return ""
	}
	return value
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
	// Only a selector-carried scope, which the briefing GET already accepted.
	if selector.Kind == "scope" {
		req.Scope = selector.Scope
	}

	body, err := json.Marshal(req)
	if err != nil {
		return ""
	}
	respBody, status, err := apiRequest("POST", "/api/v1/agent-sessions/open", body, 3*time.Second)
	if err != nil || status >= 400 {
		logSessionFailure("open", status, err)
		return ""
	}
	var resp sessionOpenResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return ""
	}
	return resp.SessionRunID
}

// sessionHeartbeat refreshes the lease by natural key, optionally snapshotting
// the turn's bounded last_assistant_message. `found` is false when the tenant
// owns no row for the key (404) — the compact and clear paths use that as the
// existence answer, and Stop uses it to stay silent.
func sessionHeartbeat(key agentSessionKey, excerpt string, timeout time.Duration) (runID string, found bool) {
	body, err := json.Marshal(sessionHeartbeatRequest{
		Agent:              key.Agent,
		SessionID:          key.SessionID,
		LastMessageExcerpt: excerpt,
	})
	if err != nil {
		return "", false
	}
	respBody, status, err := apiRequest("POST", "/api/v1/agent-sessions/heartbeat", body, timeout)
	if err != nil || status >= 400 {
		logSessionFailure("heartbeat", status, err)
		return "", false
	}
	var resp sessionHeartbeatResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return "", false
	}
	return resp.SessionRunID, true
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
		logSessionFailure("close", status, err)
	}
}

// logSessionFailure writes one bounded line to stderr. Ids and status codes
// only — no memory content, no briefing rows, no excerpt (hard rule 6).
func logSessionFailure(route string, status int, err error) {
	if err != nil {
		fmt.Fprintf(stderrWriter, "3ngram-hook: agent-sessions/%s unreachable (%v)\n", route, err)
		return
	}
	fmt.Fprintf(stderrWriter, "3ngram-hook: agent-sessions/%s returned %d\n", route, status)
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
