// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

const testRunID = "0197f5b2-1c9a-7b3d-8f21-4a6c9e2d5b70"

// captureHook drives one hook subcommand end to end with `payload` on stdin and
// returns whatever it wrote to stdout. Same pipe swap captureRunPrecheck uses;
// the run function is a parameter because every session hook has its own entry
// point and they must all be pinned to exit 0.
func captureHook(t *testing.T, payload string, run func() int) string {
	t.Helper()

	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		_, _ = inW.WriteString(payload)
		_ = inW.Close()
	}()

	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}

	origIn, origOut := os.Stdin, os.Stdout
	os.Stdin, os.Stdout = inR, outW
	t.Cleanup(func() { os.Stdin, os.Stdout = origIn, origOut })

	var captured strings.Builder
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(&captured, outR)
		close(done)
	}()

	rc := run()
	_ = outW.Close()
	<-done
	if rc != 0 {
		t.Fatalf("hook returned %d, want 0", rc)
	}
	return captured.String()
}

// recordedRequest is one captured lifecycle POST: the path plus the raw body.
type recordedRequest struct {
	path string
	body []byte
}

// lifecycleServer is an httptest backend that records every lifecycle POST and
// answers each route with the shape the REST surface ships.
type lifecycleServer struct {
	*httptest.Server
	mu           sync.Mutex
	requests     []recordedRequest
	briefingBody string
	// briefingCode / heartbeatCode let a test make one route fail while the
	// others stay healthy — the case both the briefing-failure and the
	// clear-probe-failure rules are about.
	briefingCode  int
	heartbeatCode int
	// heartbeatResurrected is echoed back on the heartbeat response.
	heartbeatResurrected bool
}

// isolateCwd moves the test into a directory that is NOT a linked git worktree,
// so the secondary-worktree filter does not suppress the hook. The repo's own
// CI and every developer checkout can be either, and this suite is about the
// lifecycle, not about the filter — which has its own tests.
func isolateCwd(t *testing.T) {
	t.Helper()
	t.Chdir(t.TempDir())
}

func newLifecycleServer(t *testing.T, briefingBody string) *lifecycleServer {
	t.Helper()
	isolateCwd(t)
	ls := &lifecycleServer{
		briefingBody:  briefingBody,
		briefingCode:  http.StatusOK,
		heartbeatCode: http.StatusOK,
	}
	ls.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		ls.mu.Lock()
		ls.requests = append(ls.requests, recordedRequest{path: r.URL.Path, body: body})
		beatCode, briefCode, resurrected := ls.heartbeatCode, ls.briefingCode, ls.heartbeatResurrected
		ls.mu.Unlock()

		switch r.URL.Path {
		case "/api/v1/briefing":
			if briefCode != http.StatusOK {
				http.Error(w, "briefing unavailable", briefCode)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(ls.briefingBody))
		case "/api/v1/agent-sessions/open":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"sessionRunId":"` + testRunID + `","activationEpoch":1,"created":true,"reopened":false}`))
		case "/api/v1/agent-sessions/heartbeat":
			if beatCode != http.StatusOK {
				http.Error(w, "heartbeat unavailable", beatCode)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = fmt.Fprintf(w,
				`{"sessionRunId":%q,"activationEpoch":2,"lastSeenAt":"2026-08-21T00:00:00Z","resurrected":%t}`,
				testRunID, resurrected)
		case "/api/v1/agent-sessions/close":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"sessionRunId":"` + testRunID + `","activationEpoch":1,"closedAt":"2026-08-21T00:00:00Z","alreadyClosed":false}`))
		default:
			http.Error(w, "wrong path", http.StatusBadRequest)
		}
	}))
	t.Cleanup(ls.Close)
	t.Setenv("THREENGRAM_API_BASE", ls.URL)
	t.Setenv("THREENGRAM_API_KEY", "3ng_test")
	t.Setenv("THREENGRAM_HOOK_ROLE", "")
	t.Setenv("THREENGRAM_BRIEFING_KIND", "all")
	t.Setenv("THREENGRAM_AGENT", "claude-code")
	// This server answers the step-5b lifecycle routes only, so the Stop tests
	// below are about the heartbeat half. Pin the nudge OFF rather than
	// inheriting it: a developer with THREENGRAM_STOP_NUDGE exported would
	// otherwise silently change what these tests exercise.
	t.Setenv("THREENGRAM_STOP_NUDGE", "")
	return ls
}

func (ls *lifecycleServer) paths() []string {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	out := make([]string, 0, len(ls.requests))
	for _, req := range ls.requests {
		out = append(out, req.path)
	}
	return out
}

func (ls *lifecycleServer) bodyFor(t *testing.T, path string) map[string]any {
	t.Helper()
	ls.mu.Lock()
	defer ls.mu.Unlock()
	for _, req := range ls.requests {
		if req.path != path {
			continue
		}
		var decoded map[string]any
		if err := json.Unmarshal(req.body, &decoded); err != nil {
			t.Fatalf("body for %s is not JSON: %v\n%s", path, err, req.body)
		}
		return decoded
	}
	t.Fatalf("no request recorded for %s (saw %v)", path, ls.requests)
	return nil
}

// briefingWith renders a briefing body carrying the given open commitments,
// echoing the axis-free `all` selector the hook requested.
func briefingWith(items []briefingCommitment) string {
	return briefingWithSelector(map[string]any{"kind": "all"}, items)
}

// briefingWithSelector is the same body with an explicit selector echo, so a
// test can stand in for a tenant retrieval policy narrowing `all` to a scope.
func briefingWithSelector(selector map[string]any, items []briefingCommitment) string {
	body := map[string]any{
		"selector":        selector,
		"mode":            "full",
		"generatedAt":     "2026-08-21T00:00:00Z",
		"commitments":     map[string]any{"count": len(items), "items": items},
		"overdue":         map[string]any{"count": 0, "items": []any{}},
		"blockers":        map[string]any{"count": 0, "items": []any{}},
		"staleCandidates": map[string]any{"count": 0, "items": []any{}},
		"recentDecisions": map[string]any{"count": 0, "items": []any{}},
		"preferences":     map[string]any{"count": 0, "items": []any{}},
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func commitmentFixtures(n int, topicPad int) []briefingCommitment {
	items := make([]briefingCommitment, 0, n)
	for i := range n {
		items = append(items, briefingCommitment{
			ID:       fmt.Sprintf("0197f5b2-1c9a-7b3d-8f21-4a6c9e2d5b%02x", i),
			MemoryID: fmt.Sprintf("0197f5b2-1c9a-7b3d-8f21-4a6c9e2d5c%02x", i),
			Topic:    fmt.Sprintf("%s%02d", strings.Repeat("t", topicPad), i),
			Status:   "open",
		})
	}
	return items
}

// TestSurvivingBriefedFollowsTheCut is the unit pin on the subtle half of the
// stamp: `briefed_memories` must record what SURVIVED local truncation, not what
// the GET returned. A row whose rendered line ends past the cut was never shown
// to the agent, and stamping it would tell the closer to resolve a commitment
// nobody read.
func TestSurvivingBriefedFollowsTheCut(t *testing.T) {
	rows := []briefedRow{
		{memory: briefedMemory{ID: "a", Topic: "one", Status: "open"}, endOffset: 10},
		{memory: briefedMemory{ID: "b", Topic: "two", Status: "open"}, endOffset: 20},
		{memory: briefedMemory{ID: "c", Topic: "three", Status: "open"}, endOffset: 30},
	}

	if got := survivingBriefed(rows, 30); len(got) != 3 {
		t.Fatalf("cut at the end kept %d rows, want 3", len(got))
	}
	// The boundary is inclusive: a line that ends EXACTLY at the cut was rendered
	// whole.
	got := survivingBriefed(rows, 20)
	if len(got) != 2 || got[0].ID != "a" || got[1].ID != "b" {
		t.Fatalf("cut at 20 kept %+v, want rows a and b", got)
	}
	// One byte short of the second line's end drops it entirely — a half-rendered
	// commitment is not a briefed one.
	got = survivingBriefed(rows, 19)
	if len(got) != 1 || got[0].ID != "a" {
		t.Fatalf("cut at 19 kept %+v, want row a only", got)
	}
	if got := survivingBriefed(rows, 0); len(got) != 0 {
		t.Fatalf("cut at 0 kept %d rows, want 0", len(got))
	}
}

// TestRenderBriefingCollectsCommitmentOffsets pins the offsets renderBriefing
// hands back against the string it renders: each row's offset must land just
// past its own line, and only COMMITMENTS are collected (a blocker or a
// preference has no status and `resolve` takes a memory id).
func TestRenderBriefingCollectsCommitmentOffsets(t *testing.T) {
	resp := briefingResponse{
		Commitments: commitmentSection{Count: 2, Items: commitmentFixtures(2, 4)},
		Overdue:     commitmentSection{Count: 0},
		Blockers: memorySection{
			Count: 1,
			Items: []briefingMemoryItem{{ID: "0197f5b2-1c9a-7b3d-8f21-4a6c9e2d5d01", Topic: "CI flake", MemoryType: "blocker"}},
		},
	}
	rendered, rows := renderBriefing(&resp, "3ngram")
	if len(rows) != 2 {
		t.Fatalf("collected %d rows, want the 2 commitments only", len(rows))
	}
	for _, row := range rows {
		if row.endOffset > len(rendered) {
			t.Fatalf("offset %d past the rendered length %d", row.endOffset, len(rendered))
		}
		// The offset is the index just past a newline-terminated line.
		if rendered[row.endOffset-1] != '\n' {
			t.Fatalf("offset %d does not land past a line end", row.endOffset)
		}
		if !strings.Contains(rendered[:row.endOffset], row.memory.Topic) {
			t.Fatalf("row %q is not inside its own prefix", row.memory.Topic)
		}
	}
	// The stamp carries the MEMORY id — the argument `resolve` takes — not the
	// commitment id.
	if rows[0].memory.ID != resp.Commitments.Items[0].MemoryID {
		t.Fatalf("stamped id %q, want the memoryId %q", rows[0].memory.ID, resp.Commitments.Items[0].MemoryID)
	}
}

// TestBriefedCollectorCapsAndDedupes pins the only two things the collector is
// allowed to enforce. Field shapes are NOT re-checked here: the server's Zod
// parse is the single validator (AGENTS.md hard rule 2), and the rows come from
// this server's own typed briefing output.
func TestBriefedCollectorCapsAndDedupes(t *testing.T) {
	var c briefedCollector

	// Values a Go-side validator would have dropped ride through untouched —
	// the server is the one that gets to reject them.
	long := strings.Repeat("t", 400)
	c.add(briefingCommitment{MemoryID: "not-a-uuid", Topic: long, Status: "open"}, 1)
	if len(c.rows) != 1 || c.rows[0].memory.Topic != long || c.rows[0].memory.ID != "not-a-uuid" {
		t.Fatalf("collector rewrote or dropped a row it does not own: %+v", c.rows)
	}

	// The overdue split re-lists commitments; the stamp is a set.
	c.add(briefingCommitment{MemoryID: "not-a-uuid", Topic: "again", Status: "open"}, 2)
	if len(c.rows) != 1 {
		t.Fatalf("duplicate memoryId collected twice: %+v", c.rows)
	}

	// The list cap is generated from MAX_BRIEFED_MEMORIES: past it the whole
	// open 400s, so the collector stops rather than trading every row for the
	// last one.
	for _, item := range commitmentFixtures(maxBriefedMemories+10, 2) {
		c.add(item, 3)
	}
	if len(c.rows) != maxBriefedMemories {
		t.Fatalf("collected %d rows, want the %d cap", len(c.rows), maxBriefedMemories)
	}
}

// TestGeneratedContractConstants guards the generated file against being
// hand-edited to nonsense. The byte-for-byte freshness gate lives in the
// docs-reference CI lane; this only asserts the values are present and sane.
func TestGeneratedContractConstants(t *testing.T) {
	if maxSessionExcerptLength <= 0 || maxBriefedMemories <= 0 {
		t.Fatalf("generated bounds are not positive: excerpt=%d briefed=%d",
			maxSessionExcerptLength, maxBriefedMemories)
	}
}

// TestRunBriefingStartupStampsSurvivorsOnly is the end-to-end pin: a briefing
// too big for BRIEFING_MAX_TOKENS is truncated locally, and the open POST
// carries ONLY the commitments whose lines survived.
func TestRunBriefingStartupStampsSurvivorsOnly(t *testing.T) {
	// Twelve padded commitments render far past the budget, so the local cut
	// lands INSIDE the commitments section — the case the stamp exists for.
	const total = 12
	ls := newLifecycleServer(t, briefingWith(commitmentFixtures(total, 20)))
	t.Setenv("BRIEFING_MAX_TOKENS", "60") // 60 tokens -> 240 chars

	out := captureHook(t, `{"session_id":"sess-1","source":"startup"}`, func() int {
		return runBriefing(nil)
	})

	body := ls.bodyFor(t, "/api/v1/agent-sessions/open")
	if body["source"] != "startup" {
		t.Fatalf("source = %v, want startup", body["source"])
	}
	if body["agent"] != "claude-code" || body["sessionId"] != "sess-1" {
		t.Fatalf("natural key = %v/%v", body["agent"], body["sessionId"])
	}
	if _, present := body["selector"]; !present {
		t.Fatalf("selector missing from open body: %v", body)
	}
	stamped, ok := body["briefedMemories"].([]any)
	if !ok {
		t.Fatalf("briefedMemories missing or not an array: %v", body["briefedMemories"])
	}
	if len(stamped) == 0 {
		t.Fatalf("nothing stamped; the cut should still leave the first rows:\n%s", out)
	}
	if len(stamped) == total {
		t.Fatalf("all %d stamped; truncation must have dropped the tail:\n%s", total, out)
	}
	// Every stamped topic must actually appear in what the agent was shown.
	for _, row := range stamped {
		topic := row.(map[string]any)["topic"].(string)
		if !strings.Contains(out, topic) {
			t.Fatalf("stamped a topic the agent never saw: %q\n%s", topic, out)
		}
	}
	if !strings.Contains(out, testRunID) {
		t.Fatalf("sessionRunId instruction missing from injected context:\n%s", out)
	}
}

// TestRunBriefingEmptyBriefingStillStamps pins the other half of the rule: a
// briefing that surfaced NOTHING is still a delivery, so the open carries
// `briefedMemories: []` and the server stamps briefing_delivered_at.
func TestRunBriefingEmptyBriefingStillStamps(t *testing.T) {
	ls := newLifecycleServer(t, briefingWith(nil))

	captureHook(t, `{"session_id":"sess-empty","source":"startup"}`, func() int {
		return runBriefing(nil)
	})

	body := ls.bodyFor(t, "/api/v1/agent-sessions/open")
	stamped, ok := body["briefedMemories"].([]any)
	if !ok || len(stamped) != 0 {
		t.Fatalf("briefedMemories = %v, want an empty array", body["briefedMemories"])
	}
}

// TestRunBriefingCompactReinjectsWithoutOpening pins the compact path: NOT an
// open and NOT a restamp, but the sessionRunId MUST come back — compaction
// discards the model-mediated id along with the context.
func TestRunBriefingCompactReinjectsWithoutOpening(t *testing.T) {
	ls := newLifecycleServer(t, briefingWith(commitmentFixtures(2, 4)))

	out := captureHook(t, `{"session_id":"sess-2","source":"compact"}`, func() int {
		return runBriefing(nil)
	})

	for _, path := range ls.paths() {
		if path == "/api/v1/agent-sessions/open" {
			t.Fatalf("compact opened a session; it must not")
		}
	}
	body := ls.bodyFor(t, "/api/v1/agent-sessions/heartbeat")
	if _, present := body["lastMessageExcerpt"]; present {
		t.Fatalf("compact heartbeat carried an excerpt: %v", body)
	}
	if !strings.Contains(out, testRunID) {
		t.Fatalf("compact did not re-inject the sessionRunId:\n%s", out)
	}
}

// TestRunBriefingResumeNeverRestamps pins resume: reuse the row, advance the
// epoch, re-inject the id (the resumed context may predate it) — but never send
// the briefing rows, because the page forbids restamping them.
func TestRunBriefingResumeNeverRestamps(t *testing.T) {
	ls := newLifecycleServer(t, briefingWith(commitmentFixtures(2, 4)))

	out := captureHook(t, `{"session_id":"sess-3","source":"resume"}`, func() int {
		return runBriefing(nil)
	})

	body := ls.bodyFor(t, "/api/v1/agent-sessions/open")
	if body["source"] != "resume" {
		t.Fatalf("source = %v, want resume", body["source"])
	}
	if _, present := body["briefedMemories"]; present {
		t.Fatalf("resume restamped briefed_memories: %v", body)
	}
	if !strings.Contains(out, testRunID) {
		t.Fatalf("resume did not inject the sessionRunId:\n%s", out)
	}
}

// TestRunBriefingClearResolvesAgainstTheServer pins the `clear` conditional. The
// harness may or may not mint a new session_id, and the hook keeps no local
// state — so the natural key is the discriminator, and ONLY a definitive 404
// answers it.
func TestRunBriefingClearResolvesAgainstTheServer(t *testing.T) {
	t.Run("404 opens as startup", func(t *testing.T) {
		ls := newLifecycleServer(t, briefingWith(commitmentFixtures(1, 4)))
		ls.heartbeatCode = http.StatusNotFound

		captureHook(t, `{"session_id":"sess-new","source":"clear"}`, func() int {
			return runBriefing(nil)
		})

		body := ls.bodyFor(t, "/api/v1/agent-sessions/open")
		if body["source"] != "startup" {
			t.Fatalf("source = %v, want startup for an unknown session id", body["source"])
		}
		if _, present := body["briefedMemories"]; !present {
			t.Fatalf("a clear-as-startup must stamp what survived: %v", body)
		}
	})

	// A reused conversation id needs no second call: the probe already returned
	// the sessionRunId and floored the lease. Posting `source=resume` on top
	// would spend another round trip and double-bump `activation_epoch` on a row
	// the probe just resurrected.
	t.Run("200 reuses the probe result without a second call", func(t *testing.T) {
		ls := newLifecycleServer(t, briefingWith(commitmentFixtures(1, 4)))

		out := captureHook(t, `{"session_id":"sess-known","source":"clear"}`, func() int {
			return runBriefing(nil)
		})

		for _, path := range ls.paths() {
			if path == "/api/v1/agent-sessions/open" {
				t.Fatalf("a known clear opened a session; the probe already answered")
			}
		}
		lifecycleCalls := 0
		for _, path := range ls.paths() {
			if strings.HasPrefix(path, "/api/v1/agent-sessions/") {
				lifecycleCalls++
			}
		}
		if lifecycleCalls != 1 {
			t.Fatalf("clear made %d lifecycle calls, want exactly the probe: %v", lifecycleCalls, ls.paths())
		}
		if !strings.Contains(out, testRunID) {
			t.Fatalf("clear did not inject the probed sessionRunId:\n%s", out)
		}
	})

	// A probe that FAILED is not an existence answer. Guessing `startup` here
	// would 409 against a live row whose stored params differ and cost the
	// session its reinjection outright.
	t.Run("a failed probe never masquerades as startup", func(t *testing.T) {
		for _, code := range []int{http.StatusInternalServerError, http.StatusUnauthorized} {
			ls := newLifecycleServer(t, briefingWith(commitmentFixtures(1, 4)))
			ls.heartbeatCode = code

			var stderr strings.Builder
			orig := stderrWriter
			stderrWriter = &stderr
			out := captureHook(t, `{"session_id":"sess-flaky","source":"clear"}`, func() int {
				return runBriefing(nil)
			})
			stderrWriter = orig

			for _, path := range ls.paths() {
				if path == "/api/v1/agent-sessions/open" {
					t.Fatalf("a %d probe opened a session", code)
				}
			}
			if strings.Contains(out, testRunID) {
				t.Fatalf("a %d probe injected a run id it never got:\n%s", code, out)
			}
			if !strings.Contains(out, "**Commitments**") {
				t.Fatalf("a %d probe suppressed the briefing:\n%s", code, out)
			}
			if !strings.Contains(stderr.String(), "agent-sessions/heartbeat") {
				t.Fatalf("a %d probe failure was not logged: %q", code, stderr.String())
			}
		}
	})
}

// TestRunBriefingOpensWhenTheBriefingFails is the other half of the
// degrade rule: the briefing read and the lifecycle write are independent
// calls. The Stop heartbeat deliberately never creates a missing row, so
// skipping the open here would leave the whole session unattributed because one
// read went wrong.
func TestRunBriefingOpensWhenTheBriefingFails(t *testing.T) {
	ls := newLifecycleServer(t, "")
	ls.briefingCode = http.StatusInternalServerError

	var stderr strings.Builder
	orig := stderrWriter
	stderrWriter = &stderr
	t.Cleanup(func() { stderrWriter = orig })

	out := captureHook(t, `{"session_id":"sess-nobrief","source":"startup"}`, func() int {
		return runBriefing(nil)
	})

	body := ls.bodyFor(t, "/api/v1/agent-sessions/open")
	if body["source"] != "startup" {
		t.Fatalf("source = %v, want startup", body["source"])
	}
	// No briefing was DELIVERED, so the key is omitted: an empty array would
	// tell the server to stamp briefing_delivered_at for a delivery that never
	// happened.
	if _, present := body["briefedMemories"]; present {
		t.Fatalf("stamped a delivery that never happened: %v", body)
	}
	if !strings.Contains(out, "Run /briefing for") {
		t.Fatalf("fallback text not printed:\n%s", out)
	}
	if !strings.Contains(out, testRunID) {
		t.Fatalf("sessionRunId not injected after a failed briefing:\n%s", out)
	}
	if !strings.Contains(stderr.String(), "briefing") {
		t.Fatalf("briefing failure was not logged: %q", stderr.String())
	}
}

// TestRunBriefingMalformedBodyStillOpens is the same rule for a 200 whose body
// does not parse.
func TestRunBriefingMalformedBodyStillOpens(t *testing.T) {
	ls := newLifecycleServer(t, `{"selector":`)

	out := captureHook(t, `{"session_id":"sess-garbled","source":"startup"}`, func() int {
		return runBriefing(nil)
	})

	body := ls.bodyFor(t, "/api/v1/agent-sessions/open")
	if _, present := body["briefedMemories"]; present {
		t.Fatalf("stamped a delivery from an unparseable body: %v", body)
	}
	if !strings.Contains(out, "Run /briefing for") {
		t.Fatalf("fallback text not printed:\n%s", out)
	}
}

// TestRunBriefingStoresTheEffectiveSelector pins the selector echo. A tenant
// retrieval policy can narrow a requested `kind=all` to its default scope; the
// row must record the lens the agent actually read through, not the one the
// hook asked for, or later selector-based processing works off wrong metadata.
func TestRunBriefingStoresTheEffectiveSelector(t *testing.T) {
	narrowed := map[string]any{"kind": "scope", "scope": "work"}
	ls := newLifecycleServer(t, briefingWithSelector(narrowed, commitmentFixtures(1, 4)))
	// The hook REQUESTED the axis-free selector.
	t.Setenv("THREENGRAM_BRIEFING_KIND", "all")

	captureHook(t, `{"session_id":"sess-narrow","source":"startup"}`, func() int {
		return runBriefing(nil)
	})

	body := ls.bodyFor(t, "/api/v1/agent-sessions/open")
	selector, ok := body["selector"].(map[string]any)
	if !ok {
		t.Fatalf("selector missing from open body: %v", body)
	}
	if selector["kind"] != "scope" || selector["scope"] != "work" {
		t.Fatalf("persisted the requested selector %v, want the echoed {scope, work}", selector)
	}
	// The row's scope facet is derived from the same effective selector.
	if body["scope"] != "work" {
		t.Fatalf("scope = %v, want work", body["scope"])
	}
}

// TestRunBriefingWithoutSessionIdSkipsLifecycle pins the tolerant path: a manual
// invocation or a harness that sends no stdin still gets a briefing, but the
// natural key needs a session id nothing else can supply.
func TestRunBriefingWithoutSessionIdSkipsLifecycle(t *testing.T) {
	ls := newLifecycleServer(t, briefingWith(commitmentFixtures(1, 4)))

	out := captureHook(t, ``, func() int { return runBriefing(nil) })

	for _, path := range ls.paths() {
		if strings.HasPrefix(path, "/api/v1/agent-sessions/") {
			t.Fatalf("lifecycle call %s made without a session id", path)
		}
	}
	if strings.Contains(out, testRunID) {
		t.Fatalf("injected a run id with no session row:\n%s", out)
	}
}

// TestRunBriefingOmitsUnknownProject pins the page's rule: never persist the
// literal "unknown" deriveProject returns for an empty cwd — omit the facet.
func TestRunBriefingOmitsUnknownProject(t *testing.T) {
	ls := newLifecycleServer(t, briefingWith(nil))

	captureHook(t, `{"session_id":"sess-4","source":"startup"}`, func() int {
		// The selector is forced to `all`, and sessionOpen omits an "unknown"
		// project, so a repo-less cwd cannot leak the placeholder.
		return runSessionStartForTest("sess-4", "startup", "unknown")
	})

	body := ls.bodyFor(t, "/api/v1/agent-sessions/open")
	if project, present := body["project"]; present {
		t.Fatalf("open carried project %v; unknown must be omitted", project)
	}
}

// runSessionStartForTest drives the lifecycle branch alone, with an explicit
// project, so the project rule can be pinned without a git fixture.
func runSessionStartForTest(sessionID, source, project string) int {
	runSessionStart(
		sessionStartInput{SessionID: sessionID, Source: source},
		nil,
		project,
		briefingSelector{Kind: "all"},
		&[]briefedMemory{},
	)
	return 0
}

// TestBoundExcerpt pins the local truncation of last_assistant_message. The
// server 400s a longer excerpt rather than choosing which half of an agent's
// message matters, and a 400 on Stop would cost the turn its lease refresh —
// so the hook truncates and never relies on the rejection.
func TestBoundExcerpt(t *testing.T) {
	if got := boundExcerpt("  hello  "); got != "hello" {
		t.Fatalf("boundExcerpt trimmed to %q, want %q", got, "hello")
	}
	if got := boundExcerpt(""); got != "" {
		t.Fatalf("boundExcerpt(empty) = %q, want empty", got)
	}

	long := strings.Repeat("x", maxSessionExcerptLength+500)
	if got := boundExcerpt(long); len(got) != maxSessionExcerptLength {
		t.Fatalf("boundExcerpt kept %d bytes, want %d", len(got), maxSessionExcerptLength)
	}

	// A multi-byte rune must never be split: the cut backs off to a boundary, so
	// the result stays valid UTF-8 (and a byte cut is the SAFE direction against
	// the server's UTF-16 bound).
	multibyte := strings.Repeat("é", maxSessionExcerptLength)
	got := boundExcerpt(multibyte)
	if len(got) > maxSessionExcerptLength {
		t.Fatalf("boundExcerpt kept %d bytes, want <= %d", len(got), maxSessionExcerptLength)
	}
	if !strings.HasSuffix(got, "é") {
		t.Fatalf("boundExcerpt split a rune: %q", got[len(got)-4:])
	}
}

// TestRunHeartbeatSendsBoundedExcerpt drives the Stop hook end to end: a
// natural-key heartbeat carrying a truncated excerpt, no stdout, exit 0.
func TestRunHeartbeatSendsBoundedExcerpt(t *testing.T) {
	ls := newLifecycleServer(t, briefingWith(nil))

	payload, err := json.Marshal(map[string]any{
		"session_id":             "sess-5",
		"stop_hook_active":       false,
		"last_assistant_message": strings.Repeat("y", maxSessionExcerptLength+100),
	})
	if err != nil {
		t.Fatal(err)
	}

	out := captureHook(t, string(payload), func() int { return runStop(nil) })
	// A Stop hook that prints is a Stop hook that can be mistaken for a decision
	// envelope. This one is heartbeat-only.
	if out != "" {
		t.Fatalf("heartbeat wrote to stdout: %q", out)
	}

	body := ls.bodyFor(t, "/api/v1/agent-sessions/heartbeat")
	excerpt, ok := body["lastMessageExcerpt"].(string)
	if !ok {
		t.Fatalf("lastMessageExcerpt missing: %v", body)
	}
	if len(excerpt) != maxSessionExcerptLength {
		t.Fatalf("excerpt length %d, want the %d cap", len(excerpt), maxSessionExcerptLength)
	}
	if body["agent"] != "claude-code" || body["sessionId"] != "sess-5" {
		t.Fatalf("natural key = %v/%v", body["agent"], body["sessionId"])
	}
}

// TestRunHeartbeatOmitsEmptyExcerpt pins the min(1) bound: an empty
// last_assistant_message is omitted rather than sent as "".
func TestRunHeartbeatOmitsEmptyExcerpt(t *testing.T) {
	ls := newLifecycleServer(t, briefingWith(nil))

	captureHook(t, `{"session_id":"sess-6","last_assistant_message":"   "}`, func() int {
		return runStop(nil)
	})

	body := ls.bodyFor(t, "/api/v1/agent-sessions/heartbeat")
	if _, present := body["lastMessageExcerpt"]; present {
		t.Fatalf("empty excerpt was sent: %v", body)
	}
}

// TestRunHeartbeatSurvivesADeadServer is the invisibility pin: when the server
// is down the Stop hook still exits 0 and prints nothing on stdout. A hook that
// can fail a turn is worse than a lapsed lease, which resurrection covers.
func TestRunHeartbeatSurvivesADeadServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	srv.Close() // nothing is listening

	isolateCwd(t)
	t.Setenv("THREENGRAM_API_BASE", srv.URL)
	t.Setenv("THREENGRAM_API_KEY", "3ng_test")
	t.Setenv("THREENGRAM_HOOK_ROLE", "")

	var stderr strings.Builder
	orig := stderrWriter
	stderrWriter = &stderr
	t.Cleanup(func() { stderrWriter = orig })

	out := captureHook(t, `{"session_id":"sess-7","last_assistant_message":"done"}`, func() int {
		return runStop(nil)
	})
	if out != "" {
		t.Fatalf("heartbeat wrote to stdout on failure: %q", out)
	}
	if !strings.Contains(stderr.String(), "agent-sessions/heartbeat") {
		t.Fatalf("failure was not logged to stderr: %q", stderr.String())
	}
}

// TestRunCloseSendsNaturalKey pins SessionEnd: one POST, natural key only, and
// explicitly NO activation epoch — SessionEnd does not have one.
func TestRunCloseSendsNaturalKey(t *testing.T) {
	ls := newLifecycleServer(t, briefingWith(nil))

	captureHook(t, `{"session_id":"sess-8","reason":"exit"}`, func() int { return runClose(nil) })

	body := ls.bodyFor(t, "/api/v1/agent-sessions/close")
	if body["agent"] != "claude-code" || body["sessionId"] != "sess-8" {
		t.Fatalf("natural key = %v/%v", body["agent"], body["sessionId"])
	}
	if len(body) != 2 {
		t.Fatalf("close body carries more than the natural key: %v", body)
	}
	if calls := ls.paths(); len(calls) != 1 {
		t.Fatalf("close made %d requests, want exactly 1: %v", len(calls), calls)
	}
}

// TestRunCloseGivesUpOnTheBudget pins the timeout. SessionEnd shares 1.5s on
// Claude Code and allows 3s on Codex, so a stalled backend must not hold the
// hook: the POST gives up at sessionEndCloseTimeout and the hook still exits 0.
func TestRunCloseGivesUpOnTheBudget(t *testing.T) {
	// A backend that stalls WELL past every SessionEnd budget. The assertion is
	// that the hook returns long before this sleep does.
	const serverStall = 2 * time.Second
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(serverStall)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	isolateCwd(t)
	t.Setenv("THREENGRAM_API_BASE", srv.URL)
	t.Setenv("THREENGRAM_API_KEY", "3ng_test")
	t.Setenv("THREENGRAM_HOOK_ROLE", "")

	var stderr strings.Builder
	orig := stderrWriter
	stderrWriter = &stderr
	t.Cleanup(func() { stderrWriter = orig })

	start := time.Now()
	captureHook(t, `{"session_id":"sess-9","reason":"exit"}`, func() int { return runClose(nil) })
	elapsed := time.Since(start)

	if sessionEndCloseTimeout > 1500*time.Millisecond {
		t.Fatalf("close timeout %v exceeds the Claude SessionEnd budget", sessionEndCloseTimeout)
	}
	// The CLIENT timeout, not the server, is what ends the call: the handler is
	// still sleeping when the hook has already exited.
	if elapsed >= serverStall {
		t.Fatalf("close waited %v for the server; the %v client timeout must win", elapsed, sessionEndCloseTimeout)
	}
	if !strings.Contains(stderr.String(), "agent-sessions/close") {
		t.Fatalf("timeout was not logged to stderr: %q", stderr.String())
	}
}

// TestDeriveAgent pins the natural key's agent half. The `--agent` flag wins
// because a hook registration is the one place that knows for certain which
// harness runs the binary.
func TestDeriveAgent(t *testing.T) {
	t.Run("flag beats everything", func(t *testing.T) {
		t.Setenv("THREENGRAM_AGENT", "codex")
		t.Setenv("CLAUDECODE", "1")
		if got := deriveAgent([]string{"--agent", "cursor"}); got != "cursor" {
			t.Fatalf("deriveAgent = %q, want cursor", got)
		}
		if got := deriveAgent([]string{"--agent=copilot-cli"}); got != "copilot-cli" {
			t.Fatalf("deriveAgent = %q, want copilot-cli", got)
		}
	})
	t.Run("env override beats detection", func(t *testing.T) {
		t.Setenv("THREENGRAM_AGENT", "Codex")
		t.Setenv("CLAUDECODE", "1")
		if got := deriveAgent(nil); got != "codex" {
			t.Fatalf("deriveAgent = %q, want codex", got)
		}
	})
	// An operator-supplied name is normalized but NOT validated: a name the
	// server rejects is a loud 400, where silently swapping in a detected
	// harness would split one operator's sessions across two natural keys.
	t.Run("passes an operator name through for the server to judge", func(t *testing.T) {
		t.Setenv("THREENGRAM_AGENT", "not a name!")
		t.Setenv("CLAUDECODE", "1")
		if got := deriveAgent(nil); got != "not a name!" {
			t.Fatalf("deriveAgent = %q, want the operator's name verbatim", got)
		}
	})
	t.Run("falls back to the placeholder and says so once", func(t *testing.T) {
		t.Setenv("THREENGRAM_AGENT", "")
		t.Setenv("CLAUDECODE", "")
		t.Setenv("CLAUDE_CODE_ENTRYPOINT", "")
		t.Setenv("CODEX_HOME", "")
		t.Setenv("CODEX_SANDBOX", "")

		var stderr strings.Builder
		orig := stderrWriter
		stderrWriter = &stderr
		t.Cleanup(func() { stderrWriter = orig })
		unknownAgentOnce = sync.Once{}
		t.Cleanup(func() { unknownAgentOnce = sync.Once{} })

		if got := deriveAgent(nil); got != unknownAgent {
			t.Fatalf("deriveAgent = %q, want %q", got, unknownAgent)
		}
		if !strings.Contains(stderr.String(), unknownAgent) {
			t.Fatalf("placeholder was not announced: %q", stderr.String())
		}
		// Once per process: the hook runs on every session event.
		deriveAgent(nil)
		if strings.Count(stderr.String(), "harness not detected") != 1 {
			t.Fatalf("placeholder diagnostic repeated: %q", stderr.String())
		}
	})
}

// TestSessionHeartbeatReportsResurrection pins the tri-state's third field: the
// server tells us when a refresh revived a closed or lease-expired row and
// advanced the epoch, and a call made to ASK a question should not mutate state
// invisibly.
func TestSessionHeartbeatReportsResurrection(t *testing.T) {
	ls := newLifecycleServer(t, briefingWith(nil))
	ls.heartbeatResurrected = true

	var stderr strings.Builder
	orig := stderrWriter
	stderrWriter = &stderr
	t.Cleanup(func() { stderrWriter = orig })

	got := sessionHeartbeat(agentSessionKey{Agent: "claude-code", SessionID: "sess-dead"}, "", time.Second)
	if got.outcome != heartbeatOK || !got.resurrected || got.sessionRunID != testRunID {
		t.Fatalf("heartbeat result = %+v, want a resurrected OK carrying the run id", got)
	}
	if !strings.Contains(stderr.String(), "resurrected") {
		t.Fatalf("resurrection was not announced: %q", stderr.String())
	}
	_ = ls
}

// TestSessionHeartbeatOutcomes pins the tri-state itself: only a 404 is an
// existence answer, and heartbeatFailed is the ZERO value so a result nobody
// filled in can never read as one.
func TestSessionHeartbeatOutcomes(t *testing.T) {
	if (heartbeatResult{}).outcome != heartbeatFailed {
		t.Fatal("the zero heartbeatResult must be heartbeatFailed")
	}

	key := agentSessionKey{Agent: "claude-code", SessionID: "sess-probe"}
	cases := []struct {
		code int
		want heartbeatOutcome
	}{
		{http.StatusOK, heartbeatOK},
		{http.StatusNotFound, heartbeatNoRow},
		{http.StatusUnauthorized, heartbeatFailed},
		{http.StatusInternalServerError, heartbeatFailed},
		{http.StatusServiceUnavailable, heartbeatFailed},
	}
	for _, tc := range cases {
		ls := newLifecycleServer(t, briefingWith(nil))
		ls.heartbeatCode = tc.code

		var stderr strings.Builder
		orig := stderrWriter
		stderrWriter = &stderr
		got := sessionHeartbeat(key, "", time.Second)
		stderrWriter = orig

		if got.outcome != tc.want {
			t.Fatalf("status %d gave outcome %d, want %d", tc.code, got.outcome, tc.want)
		}
		// A 404 is an ANSWER, not a failure — it must not be logged as one.
		if tc.want == heartbeatNoRow && stderr.Len() != 0 {
			t.Fatalf("a 404 probe logged a failure: %q", stderr.String())
		}
	}
}
