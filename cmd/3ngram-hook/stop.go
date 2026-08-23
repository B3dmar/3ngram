// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"os"
	"strings"
	"time"
)

// stopHeartbeatTimeout bounds the unconditional lease refresh. It is the first
// call the hook makes on every Stop and it is deliberately unchanged from the
// heartbeat-only step-5b hook: the nudge is ADDITIVE, and a flag nobody set must
// not move the budget of a call that already ships.
const stopHeartbeatTimeout = 2 * time.Second

// stopInput is the main-agent Stop envelope. Claude Code and Codex send the same
// fields; the hook reads only the three it needs.
//
// There is no turn-count field on either harness, which is why
// `triage/begin` is called without the `turnCount` hint — see
// triageBeginRequest.
type stopInput struct {
	SessionID string `json:"session_id"`
	// StopHookActive is the harness's loop guard: a previous Stop in this turn
	// already blocked. It gates INJECTION only (the page: it "never injects a new
	// prompt; it only finalizes or expires") and is explicitly NOT the cap —
	// Codex has no cap at all, Claude's is configurable, and the field can fail
	// to propagate (anthropics/claude-code#54360). The cap is
	// maxInjectionsPerAttempt, which does not depend on this field.
	StopHookActive       bool   `json:"stop_hook_active"`
	LastAssistantMessage string `json:"last_assistant_message"`
}

// runStop is the main-agent Stop hook. It does two jobs, and the split between
// them is the whole shape of this file:
//
//  1. UNCONDITIONALLY, exactly as step 5b shipped it: refresh `last_seen_at` so
//     the lease stays live across completed turns, and snapshot the turn's
//     bounded `last_assistant_message` for the closer — SessionEnd has no
//     final-message field, so without this path the closer sees null in the
//     common case (docs/concepts/session-continuity.mdx layer 1 "Lease" and
//     "PreCompact and Stop excerpt").
//
//  2. Behind THREENGRAM_STOP_NUDGE=1 only: the layer-4 triage handshake, which
//     may emit a continuation envelope (nudge.go).
//
// ONE SUBCOMMAND, NOT TWO. Matching hooks launch concurrently with no ordering
// guarantee, so registering `heartbeat` and a separate `nudge` would race — the
// race is harmless (a heartbeat and a `triage/begin` touch different columns and
// both floor the lease) but it would spend two processes and two connections per
// turn to achieve what one sequential process does. Doing both here also makes
// the ordering a fact rather than a hope: the lease is refreshed BEFORE the
// nudge can spend the budget, so a slow or armed triage can never cost the turn
// its heartbeat. `heartbeat` stays registered as an alias (main.go) so existing
// settings.json files keep working unchanged.
//
// With the flag unset this is byte-identical to the heartbeat-only Stop: one
// POST, nothing on stdout, no `decision` envelope, exit 0 on every path
// including a dead server.
//
// Register main-agent Stop ONLY — not SubagentStop, not secondary worktrees,
// not THREENGRAM_HOOK_ROLE=subagent.
func runStop(args []string) int {
	cwd, _ := os.Getwd()
	if hookSuppressed(cwd) {
		return 0
	}
	if apiKey() == "" {
		return 0
	}

	var input stopInput
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		return 0
	}
	sessionID := strings.TrimSpace(input.SessionID)
	if sessionID == "" {
		return 0
	}

	key := agentSessionKey{Agent: deriveAgent(args), SessionID: sessionID}
	// A 404 here is ordinary: the binary may have been installed mid-session, so
	// Stop can fire for a conversation SessionStart never opened. sessionHeartbeat
	// logs and returns; there is nothing to create from Stop.
	sessionHeartbeat(key, boundExcerpt(input.LastAssistantMessage), stopHeartbeatTimeout)

	if !stopNudgeEnabled() {
		return 0
	}
	return runStopNudge(key, input, deriveProject(cwd))
}
