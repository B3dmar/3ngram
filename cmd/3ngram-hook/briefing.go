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

// sessionStartInput is the SessionStart envelope Claude Code and Codex both
// send on stdin. `source` is the matcher that fired
// (startup|resume|clear|compact).
type sessionStartInput struct {
	SessionID string `json:"session_id"`
	Source    string `json:"source"`
}

// runBriefing is the SessionStart hook. It fetches a single orientation briefing
// from GET /api/v1/briefing (replacing the old 4× dashboard reads), renders it
// as a compact markdown summary on stdout, and drives the session-lifecycle row
// (docs/concepts/session-continuity.mdx layer 1, the `source` table). Pure
// context — it never blocks the session and stays silent on every failure path.
func runBriefing(args []string) int {
	cwd, _ := os.Getwd()
	project := deriveProject(cwd)
	if project == "" {
		project = "unknown"
	}

	// Skip the auto-pull for Task-dispatched sub-agents (which inherit the main
	// worktree cwd) and for secondary worktrees. THREENGRAM_HOOK_ROLE=subagent
	// makes the skip explicit and role-based, independent of the path check.
	if hookSuppressed(cwd) {
		return 0
	}

	if apiKey() == "" {
		return 0
	}

	// Tolerant: a harness that sends no stdin (or a manual invocation) still gets
	// the briefing, just without the lifecycle row — the natural key needs a
	// session id nothing else can supply.
	var input sessionStartInput
	_ = json.NewDecoder(os.Stdin).Decode(&input)

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

	// A briefing that surfaced NOTHING is still a delivery: `briefedMemories`
	// stays an empty (non-nil) slice so the open POST carries the key and the
	// server stamps briefing_delivered_at.
	output := fallback
	briefed := []briefedMemory{}

	total := resp.Commitments.Count + resp.Overdue.Count + resp.Blockers.Count +
		resp.StaleCandidates.Count + resp.RecentDecisions.Count + resp.Preferences.Count
	if total > 0 {
		rendered, rows := renderBriefing(&resp, project)
		// THE STAMP IS WHAT SURVIVED THE CUT, not what the GET returned —
		// otherwise briefed_memories records commitments the agent never read.
		cut := len(rendered)
		if len(rendered) > maxChars+200 {
			cut = runeSafeCut(rendered, maxChars)
			rendered = rendered[:cut] + "..."
		}
		output = rendered
		briefed = survivingBriefed(rows, cut)
	}

	// Appended AFTER the truncation so the run id can never be the thing the
	// budget cuts off.
	if runID := runSessionStart(input, args, project, selector, briefed); runID != "" {
		output += sessionRunInstruction(runID)
	}

	fmt.Println(output)
	return 0
}

// runSessionStart resolves the SessionStart `source` against the session row and
// returns the sessionRunId to inject, or "" when there is none to inject.
//
// | source  | call                                                              |
// |---------|-------------------------------------------------------------------|
// | startup | POST /open source=startup, carrying the surviving briefed rows    |
// | resume  | POST /open source=resume — epoch + 1, reopen, NEVER restamp       |
// | compact | POST /heartbeat — NOT an open, NOT a restamp (see below)          |
// | clear   | heartbeat probe: unknown key -> startup, known key -> resume      |
//
// COMPACT is a heartbeat because that is the least-side-effect shipped call that
// returns a sessionRunId for a natural key. Compaction discards the
// model-mediated id with the context, so the id MUST be re-injected; but compact
// is "not an open, not a restamp — same row, same briefing stamp", and there is
// no natural-key GET on the session row. On a live row a heartbeat leaves the
// epoch and every briefing field untouched and only floors `last_seen_at`, which
// SessionStart is explicitly allowed to do. A source=resume open would have bumped
// the epoch for an activation that never happened.
//
// CLEAR is the conditional the page asks for — "startup of a new conversation if
// the harness mints a new session_id; otherwise same as resume" — decided by
// asking the SERVER rather than by keeping local state: the natural key is the
// discriminator, and a heartbeat 404 is exactly "this tenant owns no row for
// this conversation id".
func runSessionStart(input sessionStartInput, args []string, project string, selector briefingSelector, briefed []briefedMemory) string {
	sessionID := strings.TrimSpace(input.SessionID)
	if sessionID == "" {
		return ""
	}
	key := agentSessionKey{Agent: deriveAgent(args), SessionID: sessionID}

	switch strings.TrimSpace(input.Source) {
	case "compact":
		runID, _ := sessionHeartbeat(key, "", 3*time.Second)
		return runID
	case "resume":
		return sessionOpen(key, "resume", project, selector, nil)
	case "clear":
		if _, known := sessionHeartbeat(key, "", 3*time.Second); known {
			return sessionOpen(key, "resume", project, selector, nil)
		}
		return sessionOpen(key, "startup", project, selector, &briefed)
	default:
		return sessionOpen(key, "startup", project, selector, &briefed)
	}
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
//
// `mode=full` is REQUIRED, not a preference. The default `brief` slice is counts
// plus a small top slice per section, and the SessionStart contract is "every
// startup delivers today's full bounded live-state briefing" — a briefing that
// silently dropped open commitments would also stamp `briefed_memories` the
// closer then treats as everything the agent saw. The local
// `BRIEFING_MAX_TOKENS` truncation is what bounds the output, and the surviving
// rows are what gets stamped.
func buildBriefingQuery(s briefingSelector) string {
	values := url.Values{}
	values.Set("kind", s.Kind)
	switch s.Kind {
	case "scope":
		values.Set("scope", s.Scope)
	case "project":
		values.Set("project", s.Project)
	}
	values.Set("mode", "full")
	return "?" + values.Encode()
}

// briefedRow pairs one briefed commitment with the byte offset just past the
// line that rendered it. That offset is the whole point: local truncation
// happens on the RENDERED string, so "which rows did the agent actually see" is
// answerable only by replaying the cut against per-row offsets.
type briefedRow struct {
	memory    briefedMemory
	endOffset int
}

// survivingBriefed returns the rows whose rendered line ended at or before the
// truncation point — the exact set the open POST is allowed to stamp.
func survivingBriefed(rows []briefedRow, cut int) []briefedMemory {
	survivors := make([]briefedMemory, 0, len(rows))
	for _, row := range rows {
		if row.endOffset <= cut {
			survivors = append(survivors, row.memory)
		}
	}
	return survivors
}

// briefedCollector accumulates the stampable commitment rows in render order,
// enforcing the server's bounds locally: an over-long topic or an id the schema
// would reject 400s the whole open and costs the session its sessionRunId.
type briefedCollector struct {
	rows []briefedRow
	seen map[string]struct{}
}

// add records one commitment. Only COMMITMENTS are stampable: they are the only
// briefing rows carrying `{id, topic, status}`, and `resolve` — the verb the
// closer and the debrief nudge use the stamp for — takes a memory id.
func (c *briefedCollector) add(item briefingCommitment, endOffset int) {
	if len(c.rows) >= maxBriefedMemories {
		return
	}
	if !looksLikeUUID(item.MemoryID) || item.Topic == "" || item.Status == "" {
		return
	}
	if c.seen == nil {
		c.seen = map[string]struct{}{}
	}
	// The overdue split re-lists commitments, so the same memory can render
	// twice; the stamp is a set.
	if _, dup := c.seen[item.MemoryID]; dup {
		return
	}
	c.seen[item.MemoryID] = struct{}{}
	c.rows = append(c.rows, briefedRow{
		memory: briefedMemory{
			ID:     item.MemoryID,
			Topic:  item.Topic[:runeSafeCut(item.Topic, maxBriefedTopic)],
			Status: item.Status[:runeSafeCut(item.Status, maxBriefedStatus)],
		},
		endOffset: endOffset,
	})
}

// looksLikeUUID is the cheap shape check that keeps a malformed id out of the
// open body. The server is the authority; this only avoids trading a whole
// sessionRunId for one bad row.
func looksLikeUUID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for i, r := range id {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			isHex := (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
			if !isHex {
				return false
			}
		}
	}
	return true
}

// renderBriefing returns the markdown briefing AND the per-commitment offsets
// the truncation replay needs.
func renderBriefing(resp *briefingResponse, project string) (string, []briefedRow) {
	var out strings.Builder
	var collector briefedCollector

	fmt.Fprintf(&out, "## 3ngram Session Briefing: %s\n\n", project)

	out.WriteString("**Overdue**:\n")
	writeCommitments(&out, resp.Overdue, &collector)
	out.WriteString("\n")
	fmt.Fprintf(&out, "**Blockers**:\n%s\n", formatMemories(resp.Blockers))
	out.WriteString("**Commitments**:\n")
	writeCommitments(&out, resp.Commitments, &collector)
	out.WriteString("\n")
	fmt.Fprintf(&out, "**Stale**:\n%s\n", formatMemories(resp.StaleCandidates))
	fmt.Fprintf(&out, "**Recent decisions**:\n%s\n", formatMemories(resp.RecentDecisions))
	fmt.Fprintf(&out, "**Preferences**:\n%s", formatMemories(resp.Preferences))

	return out.String(), collector.rows
}

// writeCommitments renders one commitment section INTO the shared builder, so
// the offset it hands the collector is absolute in the final briefing. A nil
// collector renders the same bytes and records nothing.
func writeCommitments(out *strings.Builder, section commitmentSection, collector *briefedCollector) {
	if section.Count == 0 || len(section.Items) == 0 {
		out.WriteString("None")
		return
	}
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
		if collector != nil {
			collector.add(item, out.Len())
		}
	}
	if section.Count > len(section.Items) {
		fmt.Fprintf(out, "...and %d more\n", section.Count-len(section.Items))
	}
}

func formatCommitments(section commitmentSection) string {
	var out strings.Builder
	writeCommitments(&out, section, nil)
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
