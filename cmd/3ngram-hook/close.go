// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"os"
	"strings"
	"time"
)

// sessionEndCloseTimeout is deliberately tighter than every other call in the
// binary. SessionEnd shares a 1.5s budget on Claude Code and allows 3s on Codex
// (docs/concepts/session-continuity.mdx, "Hook mechanics"), and a session is
// already terminating — a hook that outlives the budget is killed anyway, so the
// honest ceiling is one POST that gives up first.
const sessionEndCloseTimeout = time.Second

// sessionEndInput is the SessionEnd envelope. `reason` is ignored: every reason
// ends the conversation, and close is idempotent by natural key.
type sessionEndInput struct {
	SessionID string `json:"session_id"`
}

// runClose is the SessionEnd hook (docs/concepts/session-continuity.mdx layer
// 6). One `POST /api/v1/agent-sessions/close` by natural key, no
// `activation_epoch` — SessionEnd does not have one and must not persist a local
// activation token to get one.
//
// Best-effort BY CONSTRUCTION. A killed terminal, a crash or a failed POST
// leaves the row open, and that is fine: the lease plus the closer's
// lease-expiry sweep are the liveness signal, not this call. A stale close is
// transient too — the next heartbeat or resume resurrects the row and bumps the
// epoch. Exits 0 regardless.
//
// This is a SEPARATE subcommand from `sync`, which stays the deferred no-op it
// has always been: pushing files and closing a session row are different jobs
// and the second must not inherit the first's 10s timeouts.
func runClose(args []string) int {
	cwd, _ := os.Getwd()
	if hookSuppressed(cwd) {
		return 0
	}
	if apiKey() == "" {
		return 0
	}

	var input sessionEndInput
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		return 0
	}
	sessionID := strings.TrimSpace(input.SessionID)
	if sessionID == "" {
		return 0
	}

	sessionClose(agentSessionKey{Agent: deriveAgent(args), SessionID: sessionID}, sessionEndCloseTimeout)
	return 0
}
