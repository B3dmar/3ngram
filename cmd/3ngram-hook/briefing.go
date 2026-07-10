// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// briefingResponse mirrors packages/schema/src/mcp.ts briefingToolOutputSchema —
// the rich shape returned by GET /api/v1/briefing. The hook never redefines the
// contract; it consumes the fields it renders and ignores the rest. No section
// carries memory content (that is the handoff tool's job).
type briefingResponse struct {
	Selector        briefingSelector  `json:"selector"`
	Mode            string            `json:"mode"`
	GeneratedAt     string            `json:"generatedAt"`
	Commitments     commitmentSection `json:"commitments"`
	Overdue         commitmentSection `json:"overdue"`
	Blockers        memorySection     `json:"blockers"`
	StaleCandidates memorySection     `json:"staleCandidates"`
	RecentDecisions memorySection     `json:"recentDecisions"`
	Preferences     memorySection     `json:"preferences"`
}

type briefingSelector struct {
	Kind    string `json:"kind"`
	Scope   string `json:"scope,omitempty"`
	Project string `json:"project,omitempty"`
}

type commitmentSection struct {
	Count int                  `json:"count"`
	Items []briefingCommitment `json:"items"`
}

type memorySection struct {
	Count int                  `json:"count"`
	Items []briefingMemoryItem `json:"items"`
}

type briefingCommitment struct {
	ID       string `json:"id"`
	MemoryID string `json:"memoryId"`
	Topic    string `json:"topic"`
	Status   string `json:"status"`
	DueAt    string `json:"dueAt"`
	Overdue  bool   `json:"overdue"`
}

type briefingMemoryItem struct {
	ID         string `json:"id"`
	MemoryType string `json:"memoryType"`
	Topic      string `json:"topic"`
	Scope      string `json:"scope"`
	Project    string `json:"project"`
	RecordedAt string `json:"recordedAt"`
	UpdatedAt  string `json:"updatedAt"`
}

// runBriefing is the SessionStart hook. It fetches a single orientation briefing
// from GET /api/v1/briefing (replacing the old 4× dashboard reads) and renders it
// as a compact markdown summary on stdout. Pure context — it never blocks the
// session and stays silent on every failure path.
func runBriefing() int {
	cwd, _ := os.Getwd()
	project := deriveProject(cwd)
	if project == "" {
		project = "unknown"
	}

	// Skip the auto-pull for Task-dispatched sub-agents (which inherit the main
	// worktree cwd) and for secondary worktrees. THREENGRAM_HOOK_ROLE=subagent
	// makes the skip explicit and role-based, independent of the path check.
	if os.Getenv("THREENGRAM_HOOK_ROLE") == "subagent" || isSecondaryWorktree(cwd) {
		return 0
	}

	if apiKey() == "" {
		return 0
	}

	maxTokens := envInt("BRIEFING_MAX_TOKENS", 2000)
	maxChars := maxTokens * 4

	selector := deriveBriefingSelector(project)
	query := buildBriefingQuery(selector)

	fallback := fmt.Sprintf("3ngram: Run /briefing for %s context (recent decisions, blockers, commitments)", project)

	body, status, err := apiRequest("GET", "/api/v1/briefing"+query, nil, 5*time.Second)
	if err != nil || status >= 400 {
		return 0
	}

	var resp briefingResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return 0
	}

	total := resp.Commitments.Count + resp.Overdue.Count + resp.Blockers.Count +
		resp.StaleCandidates.Count + resp.RecentDecisions.Count + resp.Preferences.Count
	if total == 0 {
		fmt.Println(fallback)
		return 0
	}

	output := renderBriefing(&resp, project)
	if len(output) > maxChars+200 {
		output = output[:maxChars] + "..."
	}

	fmt.Println(output)
	return 0
}

// deriveBriefingSelector picks the no-firehose selector for the hook's context.
// Precedence: explicit THREENGRAM_BRIEFING_KIND override → a resolved project →
// the `all` fallback. A `scope` kind reads THREENGRAM_SCOPE; a `project` kind
// uses the derived project.
func deriveBriefingSelector(project string) briefingSelector {
	kind := strings.TrimSpace(os.Getenv("THREENGRAM_BRIEFING_KIND"))
	switch kind {
	case "all":
		return briefingSelector{Kind: "all"}
	case "scope":
		if scope := strings.TrimSpace(os.Getenv("THREENGRAM_SCOPE")); scope != "" {
			return briefingSelector{Kind: "scope", Scope: scope}
		}
		return briefingSelector{Kind: "all"}
	case "project":
		if project != "" && project != "unknown" {
			return briefingSelector{Kind: "project", Project: project}
		}
		return briefingSelector{Kind: "all"}
	}

	if project != "" && project != "unknown" {
		return briefingSelector{Kind: "project", Project: project}
	}
	return briefingSelector{Kind: "all"}
}

// buildBriefingQuery encodes the selector as the REST GET's flat query keys
// (kind plus the matching scope/project), exactly as router.ts reshapes them
// back into the nested selector before the single schema parse.
func buildBriefingQuery(s briefingSelector) string {
	values := url.Values{}
	values.Set("kind", s.Kind)
	switch s.Kind {
	case "scope":
		values.Set("scope", s.Scope)
	case "project":
		values.Set("project", s.Project)
	}
	return "?" + values.Encode()
}

func renderBriefing(resp *briefingResponse, project string) string {
	var out strings.Builder
	fmt.Fprintf(&out, "## 3ngram Session Briefing: %s\n\n", project)

	fmt.Fprintf(&out, "**Overdue**:\n%s\n", formatCommitments(resp.Overdue))
	fmt.Fprintf(&out, "**Blockers**:\n%s\n", formatMemories(resp.Blockers))
	fmt.Fprintf(&out, "**Commitments**:\n%s\n", formatCommitments(resp.Commitments))
	fmt.Fprintf(&out, "**Stale**:\n%s\n", formatMemories(resp.StaleCandidates))
	fmt.Fprintf(&out, "**Recent decisions**:\n%s\n", formatMemories(resp.RecentDecisions))
	fmt.Fprintf(&out, "**Preferences**:\n%s", formatMemories(resp.Preferences))

	return out.String()
}

func formatCommitments(section commitmentSection) string {
	if section.Count == 0 || len(section.Items) == 0 {
		return "None"
	}
	var out strings.Builder
	for _, item := range section.Items {
		line := fmt.Sprintf("- **%s** (%s)", item.Topic, item.Status)
		if item.DueAt != "" {
			line += fmt.Sprintf(" due %s", item.DueAt)
		}
		if item.Overdue {
			line += " [overdue]"
		}
		out.WriteString(line)
		out.WriteString("\n")
	}
	if section.Count > len(section.Items) {
		fmt.Fprintf(&out, "...and %d more\n", section.Count-len(section.Items))
	}
	return out.String()
}

func formatMemories(section memorySection) string {
	if section.Count == 0 || len(section.Items) == 0 {
		return "None"
	}
	var out strings.Builder
	for _, item := range section.Items {
		line := fmt.Sprintf("- **%s**", item.Topic)
		if item.MemoryType != "" {
			line += fmt.Sprintf(" (%s)", item.MemoryType)
		}
		out.WriteString(line)
		out.WriteString("\n")
	}
	if section.Count > len(section.Items) {
		fmt.Fprintf(&out, "...and %d more\n", section.Count-len(section.Items))
	}
	return out.String()
}

func envInt(key string, defaultVal int) int {
	if s := os.Getenv(key); s != "" {
		if v, err := strconv.Atoi(s); err == nil {
			return v
		}
	}
	return defaultVal
}
