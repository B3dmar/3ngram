// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"os"
	"strings"
	"time"
)

// stopInput is the main-agent Stop envelope. Claude Code and Codex send the
// same fields; the hook reads only the two it needs.
//
// `stop_hook_active` is decoded but deliberately UNUSED: this is the
// heartbeat-only Stop of step 5b, which never blocks and never injects, so the
// loop guard has nothing to guard. Triage is step 7.
type stopInput struct {
	SessionID            string `json:"session_id"`
	LastAssistantMessage string `json:"last_assistant_message"`
}

// runHeartbeat is the main-agent Stop hook (docs/concepts/session-continuity.mdx
// layer 1 "Lease" and "PreCompact and Stop excerpt"). It refreshes
// `last_seen_at` so a session's lease stays live across completed turns, and
// snapshots the turn's bounded `last_assistant_message` for the closer —
// SessionEnd has no final-message field, so without this path the closer sees
// null in the common case.
//
// NO triage logic and NO decision envelope. It prints nothing on stdout, emits
// no `{"decision":"block"}`, and exits 0 on every path including a dead server:
// a heartbeat that can stall or continue a turn is a worse bug than a lapsed
// lease, which resurrection already covers.
//
// Register main-agent Stop ONLY — not SubagentStop, not secondary worktrees,
// not THREENGRAM_HOOK_ROLE=subagent.
func runHeartbeat(args []string) int {
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
	sessionHeartbeat(key, boundExcerpt(input.LastAssistantMessage), 2*time.Second)
	return 0
}
