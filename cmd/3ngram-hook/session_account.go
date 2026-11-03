// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"strings"
	"time"
)

// sessionAccountID reads only the stable account id shared with MCP's
// describe_environment. No email or credential identity enters model context.
// Run this alongside the briefing so its deadline adds no serial network budget.
func sessionAccountID(cfg readConfig, sessionID string) string {
	if strings.TrimSpace(sessionID) == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var me struct {
		ID string `json:"id"`
	}
	if apiGet(ctx, cfg, "me", "/api/v1/me", &me) != nil {
		return ""
	}
	return strings.TrimSpace(me.ID)
}
