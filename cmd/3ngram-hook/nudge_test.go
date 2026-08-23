// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// Tests for the gated Stop nudge (docs/concepts/session-continuity.mdx layer 4,
// issue #166 step 7b). The suite is organised around the four properties that
// make the nudge safe to ship at all: it is OFF by default, it never emits a
// blank envelope, it never injects twice for one attempt, and it never fails a
// turn.

// testPrompt stands in for the server-authored debrief render. It deliberately
// carries the two things that break naive string handling — embedded newlines
// and a backtick fence — because the hook's contract is to pass the text through
// VERBATIM and let encoding/json do the escaping.
const testPrompt = "Debrief this session.\n\n```json\n{\n  \"project\": \"acme\"\n}\n```\n\nResolve what you completed."

// nudgeServer is an httptest backend for the triage handshake. It answers the
// four routes a Stop can touch and records every request, so a test can assert
// on what was NOT called — which is most of what this file is about.
type nudgeServer struct {
	*httptest.Server
	mu       sync.Mutex
	requests []recordedRequest

	// beginBody is the raw triage/begin response. Raw rather than typed so a
	// test can omit `attemptId` exactly as the server does on a decline that has
	// no attempt.
	beginBody    string
	beginCode    int
	promptBody   string
	promptCode   int
	completeCode int
}

func newNudgeServer(t *testing.T) *nudgeServer {
	t.Helper()
	isolateCwd(t)
	ns := &nudgeServer{
		beginBody:    declineBody("debounce"),
		beginCode:    http.StatusOK,
		promptBody:   promptBody(testPrompt),
		promptCode:   http.StatusOK,
		completeCode: http.StatusOK,
	}
	ns.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		ns.mu.Lock()
		ns.requests = append(ns.requests, recordedRequest{path: r.URL.Path, body: body})
		beginBody, beginCode := ns.beginBody, ns.beginCode
		promptBody, promptCode := ns.promptBody, ns.promptCode
		completeCode := ns.completeCode
		ns.mu.Unlock()

		switch r.URL.Path {
		case "/api/v1/agent-sessions/heartbeat":
			w.WriteHeader(http.StatusOK)
			_, _ = fmt.Fprintf(w,
				`{"sessionRunId":%q,"activationEpoch":1,"lastSeenAt":"2026-08-23T00:00:00Z","resurrected":false}`,
				testRunID)
		case "/api/v1/agent-sessions/triage/begin":
			if beginCode != http.StatusOK {
				http.Error(w, "begin unavailable", beginCode)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(beginBody))
		case "/api/v1/agent-sessions/triage/complete":
			if completeCode != http.StatusOK {
				http.Error(w, "stale attempt", completeCode)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = fmt.Fprintf(w,
				`{"sessionRunId":%q,"triageStatus":"completed","eventCount":3,"sinceBeginCount":2,"truncated":false}`,
				testRunID)
		case "/api/v1/prompts/debrief":
			if promptCode != http.StatusOK {
				http.Error(w, "prompt unavailable", promptCode)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(promptBody))
		default:
			http.Error(w, "wrong path", http.StatusBadRequest)
		}
	}))
	t.Cleanup(ns.Close)
	t.Setenv("THREENGRAM_API_BASE", ns.URL)
	t.Setenv("THREENGRAM_API_KEY", "3ng_test")
	t.Setenv("THREENGRAM_HOOK_ROLE", "")
	t.Setenv("THREENGRAM_AGENT", "claude-code")
	t.Setenv("THREENGRAM_SCOPE", "")
	t.Setenv("THREENGRAM_STOP_NUDGE", "1")
	return ns
}

// armedBody is a begin response that ARMED: `armed:true` plus the fresh attempt.
func armedBody(attemptID string) string {
	return fmt.Sprintf(`{"sessionRunId":%q,"armed":true,"attemptId":%q,"triageStatus":"pending"}`,
		testRunID, attemptID)
}

// pendingBody is the decline that names an attempt already in flight. This is
// the self-cap's one branch: the hook must FINALIZE, never inject.
func pendingBody(attemptID string) string {
	return fmt.Sprintf(`{"sessionRunId":%q,"armed":false,"attemptId":%q,"triageStatus":"pending","reason":"pending"}`,
		testRunID, attemptID)
}

// declineBody is any decline that carries NO attempt id — there is nothing
// armed and nothing to finish.
func declineBody(reason string) string {
	return fmt.Sprintf(`{"sessionRunId":%q,"armed":false,"triageStatus":"idle","reason":%q}`,
		testRunID, reason)
}

func promptBody(prompt string) string {
	encoded, err := json.Marshal(map[string]string{"prompt": prompt})
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func (ns *nudgeServer) paths() []string {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	out := make([]string, 0, len(ns.requests))
	for _, req := range ns.requests {
		out = append(out, req.path)
	}
	return out
}

func (ns *nudgeServer) countFor(path string) int {
	n := 0
	for _, p := range ns.paths() {
		if p == path {
			n++
		}
	}
	return n
}

func (ns *nudgeServer) bodyFor(t *testing.T, path string) map[string]any {
	t.Helper()
	ns.mu.Lock()
	defer ns.mu.Unlock()
	for _, req := range ns.requests {
		if req.path != path {
			continue
		}
		var decoded map[string]any
		if err := json.Unmarshal(req.body, &decoded); err != nil {
			t.Fatalf("body for %s is not JSON: %v\n%s", path, err, req.body)
		}
		return decoded
	}
	t.Fatalf("no request recorded for %s (saw %v)", path, ns.paths())
	return nil
}

// stopPayload builds a Stop stdin envelope.
func stopPayload(sessionID string, stopHookActive bool) string {
	payload, err := json.Marshal(map[string]any{
		"session_id":             sessionID,
		"stop_hook_active":       stopHookActive,
		"last_assistant_message": "did the thing",
	})
	if err != nil {
		panic(err)
	}
	return string(payload)
}

// decodeEnvelope parses the hook's stdout as a Stop decision envelope, failing
// the test if it is not exactly one JSON object.
func decodeEnvelope(t *testing.T, out string) map[string]any {
	t.Helper()
	var envelope map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &envelope); err != nil {
		t.Fatalf("stdout is not a JSON envelope: %v\n%s", err, out)
	}
	return envelope
}

// TestStopNudgeDisabledByDefault is the gate, and the single most important test
// here. With the flag unset the Stop hook must be BYTE-IDENTICAL to the
// heartbeat-only hook that ships today: one POST, nothing on stdout, and above
// all no `triage/begin` — an unregistered, unvalidated nudge must not so much as
// arm an attempt on someone's row.
func TestStopNudgeDisabledByDefault(t *testing.T) {
	for _, value := range []string{"", "0", "true", "yes", "TRUE"} {
		t.Run(fmt.Sprintf("THREENGRAM_STOP_NUDGE=%q", value), func(t *testing.T) {
			ns := newNudgeServer(t)
			ns.beginBody = armedBody(testAttemptID)
			// Anything other than the literal "1" leaves the nudge off. A safety
			// flag should not be satisfiable by an operator's idea of truthiness.
			t.Setenv("THREENGRAM_STOP_NUDGE", value)

			out := captureHook(t, stopPayload("sess-off", false), func() int { return runStop(nil) })

			if out != "" {
				t.Fatalf("the disabled nudge wrote to stdout: %q", out)
			}
			if calls := ns.paths(); len(calls) != 1 || calls[0] != "/api/v1/agent-sessions/heartbeat" {
				t.Fatalf("disabled Stop made %v, want exactly one heartbeat", calls)
			}
		})
	}
}

const testAttemptID = "0197f5b2-1c9a-7b3d-8f21-4a6c9e2d5b71"

// TestStopNudgeDeclineIsSilent pins the common case: on most Stops the server
// declines and the hook must be invisible — no prompt fetch, no complete, no
// stdout.
func TestStopNudgeDeclineIsSilent(t *testing.T) {
	for _, reason := range []string{"debounce", "no-signal", "not-live", "terminal", "overflowed"} {
		t.Run(reason, func(t *testing.T) {
			ns := newNudgeServer(t)
			ns.beginBody = declineBody(reason)

			out := captureHook(t, stopPayload("sess-decline", false), func() int { return runStop(nil) })

			if out != "" {
				t.Fatalf("a declined nudge wrote to stdout: %q", out)
			}
			if n := ns.countFor("/api/v1/prompts/debrief"); n != 0 {
				t.Fatalf("a declined nudge fetched the prompt %d times", n)
			}
			if n := ns.countFor("/api/v1/agent-sessions/triage/complete"); n != 0 {
				t.Fatalf("a decline with no attempt still called complete %d times", n)
			}
		})
	}
}

// TestStopNudgeArmedEmitsTheClaudeEnvelope is the golden shape for the ONE
// harness registered for the validation phase.
//
// Top-level `decision`/`reason`, plus the universal `systemMessage` naming
// 3ngram as the source. Explicitly NOT `hookSpecificOutput.additionalContext`,
// which the page rules out for Stop.
func TestStopNudgeArmedEmitsTheClaudeEnvelope(t *testing.T) {
	ns := newNudgeServer(t)
	ns.beginBody = armedBody(testAttemptID)

	out := captureHook(t, stopPayload("sess-armed", false), func() int { return runStop(nil) })

	// GOLDEN JSON. Field order is the wire order, so this pins the shape and not
	// merely the values.
	want := fmt.Sprintf(`{"decision":"block","reason":%s,"systemMessage":%q}`,
		mustJSONString(testPrompt), nudgeSystemMessage)
	if strings.TrimSpace(out) != want {
		t.Fatalf("envelope mismatch\n got: %s\nwant: %s", strings.TrimSpace(out), want)
	}

	envelope := decodeEnvelope(t, out)
	if envelope["decision"] != "block" {
		t.Fatalf("decision = %v, want block", envelope["decision"])
	}
	// INJECTION SAFETY: the server's text arrives VERBATIM. Newlines and the
	// backtick fence survive as data inside one JSON string; the hook adds no
	// prefix, no trim, no wrapper.
	if envelope["reason"] != testPrompt {
		t.Fatalf("reason was modified in transit:\n got: %q\nwant: %q", envelope["reason"], testPrompt)
	}
	if _, present := envelope["hookSpecificOutput"]; present {
		t.Fatalf("Stop envelope carries hookSpecificOutput, which is not a Stop field: %v", envelope)
	}

	// The begin body carries the natural key and NO turnCount: neither harness
	// puts a turn count in the Stop payload, and the server's elapsed/signal
	// disjuncts cover the debounce without it.
	begin := ns.bodyFor(t, "/api/v1/agent-sessions/triage/begin")
	if begin["agent"] != "claude-code" || begin["sessionId"] != "sess-armed" {
		t.Fatalf("begin natural key = %v/%v", begin["agent"], begin["sessionId"])
	}
	if _, present := begin["turnCount"]; present {
		t.Fatalf("begin sent a turnCount the harness never supplied: %v", begin)
	}
	if len(begin) != 2 {
		t.Fatalf("begin body carries more than the natural key: %v", begin)
	}

	// Arming does NOT complete: the attempt stays in flight for the finalize
	// Stop. Completing here is the false-complete the handshake exists to avoid.
	if n := ns.countFor("/api/v1/agent-sessions/triage/complete"); n != 0 {
		t.Fatalf("the arming Stop completed its own attempt %d times", n)
	}
}

// TestStopNudgeCodexEnvelopeOmitsTheClaudeExtras pins the portable shape. Codex
// has no `hookSpecificOutput` and no extras on Stop, so the envelope is exactly
// `decision` + `reason` — a `systemMessage` there would be a field the harness
// never agreed to.
func TestStopNudgeCodexEnvelopeOmitsTheClaudeExtras(t *testing.T) {
	ns := newNudgeServer(t)
	ns.beginBody = armedBody(testAttemptID)
	t.Setenv("THREENGRAM_AGENT", "codex")

	out := captureHook(t, stopPayload("sess-codex", false), func() int { return runStop(nil) })

	want := fmt.Sprintf(`{"decision":"block","reason":%s}`, mustJSONString(testPrompt))
	if strings.TrimSpace(out) != want {
		t.Fatalf("codex envelope mismatch\n got: %s\nwant: %s", strings.TrimSpace(out), want)
	}
}

// TestStopNudgeUnregisteredHarnessGetsThePortableShape: an operator who names a
// harness the binary has never heard of gets the INTERSECTION of the two known
// envelopes, not a Claude-shaped one. Registration is still a per-harness
// decision — Cursor takes `followup_message` and must not be sent this at all —
// but the fallback cannot be wrong in a way the Codex envelope is not.
func TestStopNudgeUnregisteredHarnessGetsThePortableShape(t *testing.T) {
	ns := newNudgeServer(t)
	ns.beginBody = armedBody(testAttemptID)
	t.Setenv("THREENGRAM_AGENT", "copilot-cli")

	out := captureHook(t, stopPayload("sess-other", false), func() int { return runStop(nil) })

	envelope := decodeEnvelope(t, out)
	if _, present := envelope["systemMessage"]; present {
		t.Fatalf("an unregistered harness got Claude's universal extras: %v", envelope)
	}
	if envelope["decision"] != "block" || envelope["reason"] != testPrompt {
		t.Fatalf("portable envelope = %v", envelope)
	}
}

// TestStopNudgeNeverEmitsABlankReason is the Codex-safety guard: there, a blank
// `reason` is a hook FAILURE rather than a no-op. When the words cannot be
// fetched the hook declines to inject AND hands the attempt back, so the row
// lands on a closer-eligible state instead of sitting `pending` on an attempt
// nobody will finish.
func TestStopNudgeNeverEmitsABlankReason(t *testing.T) {
	cases := []struct {
		name string
		set  func(ns *nudgeServer)
	}{
		{"empty prompt", func(ns *nudgeServer) { ns.promptBody = promptBody("") }},
		{"whitespace-only prompt", func(ns *nudgeServer) { ns.promptBody = promptBody("  \n\t ") }},
		{"prompt route rejects the facets", func(ns *nudgeServer) { ns.promptCode = http.StatusBadRequest }},
		{"prompt route is down", func(ns *nudgeServer) { ns.promptCode = http.StatusInternalServerError }},
		{"prompt body is not JSON", func(ns *nudgeServer) { ns.promptBody = "<html>nope</html>" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ns := newNudgeServer(t)
			ns.beginBody = armedBody(testAttemptID)
			tc.set(ns)

			var stderr strings.Builder
			orig := stderrWriter
			stderrWriter = &stderr
			t.Cleanup(func() { stderrWriter = orig })

			out := captureHook(t, stopPayload("sess-blank", false), func() int { return runStop(nil) })

			if out != "" {
				t.Fatalf("emitted an envelope with no words: %q", out)
			}
			// The armed attempt is released rather than stranded.
			complete := ns.bodyFor(t, "/api/v1/agent-sessions/triage/complete")
			if complete["attemptId"] != testAttemptID {
				t.Fatalf("complete fenced on %v, want %v", complete["attemptId"], testAttemptID)
			}
		})
	}
}

// TestStopNudgeFinalizesOnStopHookActive is the finalize path, and the reason it
// needs no local state: the attempt id round-trips through the SERVER. `begin`
// is idempotent for a pending attempt and republishes its `attemptId` on the
// `pending` decline, which the hook then completes.
func TestStopNudgeFinalizesOnStopHookActive(t *testing.T) {
	ns := newNudgeServer(t)
	ns.beginBody = pendingBody(testAttemptID)

	out := captureHook(t, stopPayload("sess-finalize", true), func() int { return runStop(nil) })

	if out != "" {
		t.Fatalf("the finalize Stop injected: %q", out)
	}
	if n := ns.countFor("/api/v1/prompts/debrief"); n != 0 {
		t.Fatalf("the finalize Stop fetched the prompt %d times", n)
	}
	complete := ns.bodyFor(t, "/api/v1/agent-sessions/triage/complete")
	if complete["agent"] != "claude-code" || complete["sessionId"] != "sess-finalize" {
		t.Fatalf("complete natural key = %v/%v", complete["agent"], complete["sessionId"])
	}
	if complete["attemptId"] != testAttemptID {
		t.Fatalf("complete fenced on %v, want the attempt begin republished", complete["attemptId"])
	}
}

// TestStopNudgeFinalizeWithNoPendingAttemptIsANoOp: `begin` says nothing is in
// flight — the closer took the row over, or nothing was ever armed. There is no
// attempt to complete and the hook must not invent one.
func TestStopNudgeFinalizeWithNoPendingAttemptIsANoOp(t *testing.T) {
	for _, reason := range []string{"no-signal", "not-live", "terminal", "debounce"} {
		t.Run(reason, func(t *testing.T) {
			ns := newNudgeServer(t)
			ns.beginBody = declineBody(reason)

			out := captureHook(t, stopPayload("sess-nopending", true), func() int { return runStop(nil) })

			if out != "" {
				t.Fatalf("finalize with nothing pending wrote to stdout: %q", out)
			}
			if n := ns.countFor("/api/v1/agent-sessions/triage/complete"); n != 0 {
				t.Fatalf("completed %d attempts when none existed", n)
			}
		})
	}
}

// TestStopHookActiveNeverInjects is the loop-guard contract, tested on the case
// that actually threatens it: `begin` ARMS on a Stop where the harness has told
// us a block is already in flight. The page is absolute — `stop_hook_active=true`
// "never injects a new prompt; it only finalizes or expires" — so the hook must
// swallow the arm and finalize it rather than emit a second continuation.
func TestStopHookActiveNeverInjects(t *testing.T) {
	ns := newNudgeServer(t)
	ns.beginBody = armedBody(testAttemptID)

	out := captureHook(t, stopPayload("sess-armed-late", true), func() int { return runStop(nil) })

	if out != "" {
		t.Fatalf("injected while stop_hook_active=true: %q", out)
	}
	if n := ns.countFor("/api/v1/prompts/debrief"); n != 0 {
		t.Fatalf("fetched the prompt while stop_hook_active=true (%d times)", n)
	}
	// The freshly armed attempt is completed immediately rather than stranded:
	// with no writes since a begin stamp taken moments ago the row lands on
	// `expired`, which is closer-eligible. The nudge is lost, the debrief is not.
	complete := ns.bodyFor(t, "/api/v1/agent-sessions/triage/complete")
	if complete["attemptId"] != testAttemptID {
		t.Fatalf("the swallowed arm was not finalized: %v", complete)
	}
}

// TestPendingDeclineNeverInjects is the CAP PROPERTY, stated as a test.
//
// The numeric self-cap is maxInjectionsPerAttempt = 1, and it is held by the
// server's `pending` state rather than by a counter this process cannot keep.
// The property that makes that work is exactly one thing: a `pending` decline
// NEVER produces an envelope. It is asserted here independently of
// `stop_hook_active` — both values — because the harnesses that need a cap most
// (Codex, Gemini CLI 0.30.0) are the ones where that field is absent, hardcoded
// false, or fails to propagate. If the cap held only when the harness told us a
// block was in flight, it would not be a cap.
func TestPendingDeclineNeverInjects(t *testing.T) {
	for _, active := range []bool{false, true} {
		t.Run(fmt.Sprintf("stop_hook_active=%t", active), func(t *testing.T) {
			ns := newNudgeServer(t)
			ns.beginBody = pendingBody(testAttemptID)

			out := captureHook(t, stopPayload("sess-cap", active), func() int { return runStop(nil) })

			if out != "" {
				t.Fatalf("a pending decline injected a second time: %q", out)
			}
			if n := ns.countFor("/api/v1/prompts/debrief"); n != 0 {
				t.Fatalf("a pending decline fetched the prompt %d times", n)
			}
			if n := ns.countFor("/api/v1/agent-sessions/triage/begin"); n != 1 {
				t.Fatalf("begin was called %d times in one Stop, want 1", n)
			}
			// It finalizes instead — which is what breaks the loop on a harness
			// that never sets stop_hook_active.
			if n := ns.countFor("/api/v1/agent-sessions/triage/complete"); n != 1 {
				t.Fatalf("a pending decline completed %d attempts, want 1", n)
			}
		})
	}
}

// TestStopNudgeSurvivesADeadServer is the invisibility pin for the nudge half.
// The whole handshake is unreachable, and the hook must still exit 0 with
// nothing on stdout. A nudge that can fail a turn is a worse bug than a nudge
// that never fires.
func TestStopNudgeSurvivesADeadServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	srv.Close() // nothing is listening

	isolateCwd(t)
	t.Setenv("THREENGRAM_API_BASE", srv.URL)
	t.Setenv("THREENGRAM_API_KEY", "3ng_test")
	t.Setenv("THREENGRAM_HOOK_ROLE", "")
	t.Setenv("THREENGRAM_AGENT", "claude-code")
	t.Setenv("THREENGRAM_STOP_NUDGE", "1")

	var stderr strings.Builder
	orig := stderrWriter
	stderrWriter = &stderr
	t.Cleanup(func() { stderrWriter = orig })

	for _, active := range []bool{false, true} {
		out := captureHook(t, stopPayload("sess-dead", active), func() int { return runStop(nil) })
		if out != "" {
			t.Fatalf("wrote to stdout with the server down (stop_hook_active=%t): %q", active, out)
		}
	}
	if !strings.Contains(stderr.String(), "agent-sessions/triage/begin") {
		t.Fatalf("the failure was not logged to stderr: %q", stderr.String())
	}
}

// TestStopNudgeBeginFailureNeverInjects covers the non-transport failures: a
// 404 (Stop never creates a missing row), a 401, a 5xx and an unparseable body.
// None of them is an answer, and none may be guessed into an injection.
func TestStopNudgeBeginFailureNeverInjects(t *testing.T) {
	cases := []struct {
		name string
		set  func(ns *nudgeServer)
	}{
		{"unknown natural key", func(ns *nudgeServer) { ns.beginCode = http.StatusNotFound }},
		{"key rejected", func(ns *nudgeServer) { ns.beginCode = http.StatusUnauthorized }},
		{"server error", func(ns *nudgeServer) { ns.beginCode = http.StatusInternalServerError }},
		{"unparseable body", func(ns *nudgeServer) { ns.beginBody = "not json" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ns := newNudgeServer(t)
			tc.set(ns)

			var stderr strings.Builder
			orig := stderrWriter
			stderrWriter = &stderr
			t.Cleanup(func() { stderrWriter = orig })

			out := captureHook(t, stopPayload("sess-beginfail", false), func() int { return runStop(nil) })

			if out != "" {
				t.Fatalf("injected on a failed begin: %q", out)
			}
			if n := ns.countFor("/api/v1/agent-sessions/triage/complete"); n != 0 {
				t.Fatalf("completed an attempt it never learned about (%d times)", n)
			}
		})
	}
}

// TestStopNudgeStaleAttemptIsNotFatal: `complete` answers 409 because the
// attempt is no longer current — a duplicate delivery, or a closer that
// re-claimed the row after the lease expired mid-handshake. That is the fence
// doing its job, so the hook logs one line and exits 0.
func TestStopNudgeStaleAttemptIsNotFatal(t *testing.T) {
	ns := newNudgeServer(t)
	ns.beginBody = pendingBody(testAttemptID)
	ns.completeCode = http.StatusConflict

	var stderr strings.Builder
	orig := stderrWriter
	stderrWriter = &stderr
	t.Cleanup(func() { stderrWriter = orig })

	out := captureHook(t, stopPayload("sess-stale", true), func() int { return runStop(nil) })

	if out != "" {
		t.Fatalf("a stale complete wrote to stdout: %q", out)
	}
	if !strings.Contains(stderr.String(), "agent-sessions/triage/complete") {
		t.Fatalf("the 409 was not logged: %q", stderr.String())
	}
}

// TestStopNudgeStillHeartbeats pins the additive contract: the lease refresh and
// the excerpt snapshot are UNCONDITIONAL, and they happen BEFORE the nudge can
// spend any of the budget. A turn must never trade its heartbeat for a triage
// call.
func TestStopNudgeStillHeartbeats(t *testing.T) {
	ns := newNudgeServer(t)
	ns.beginBody = armedBody(testAttemptID)

	captureHook(t, stopPayload("sess-beat", false), func() int { return runStop(nil) })

	calls := ns.paths()
	if len(calls) == 0 || calls[0] != "/api/v1/agent-sessions/heartbeat" {
		t.Fatalf("the heartbeat was not the first call: %v", calls)
	}
	beat := ns.bodyFor(t, "/api/v1/agent-sessions/heartbeat")
	if beat["lastMessageExcerpt"] != "did the thing" {
		t.Fatalf("excerpt = %v", beat["lastMessageExcerpt"])
	}
}

// TestDebriefPromptQueryCarriesTheRunAndItsFacets pins what the prompt render is
// asked for. `agent` + `sessionId` are what inline `briefed_memories` as the
// id -> topic/status mapping — without them the model gets "resolve what you
// completed" and no ids, which is the failure the mapping exists to fix.
func TestDebriefPromptQueryCarriesTheRunAndItsFacets(t *testing.T) {
	var captured atomicQuery
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/prompts/debrief":
			captured.set(r.URL.Query())
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(promptBody(testPrompt)))
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = fmt.Fprintf(w, `{"sessionRunId":%q,"armed":true,"attemptId":%q,"triageStatus":"pending",`+
				`"activationEpoch":1,"lastSeenAt":"2026-08-23T00:00:00Z","resurrected":false}`,
				testRunID, testAttemptID)
		}
	}))
	t.Cleanup(srv.Close)

	isolateCwd(t)
	t.Setenv("THREENGRAM_API_BASE", srv.URL)
	t.Setenv("THREENGRAM_API_KEY", "3ng_test")
	t.Setenv("THREENGRAM_HOOK_ROLE", "")
	t.Setenv("THREENGRAM_AGENT", "claude-code")
	t.Setenv("THREENGRAM_STOP_NUDGE", "1")
	t.Setenv("THREENGRAM_SCOPE", "work")

	captureHook(t, stopPayload("sess-query", false), func() int { return runStop(nil) })

	query := captured.get()
	if query.Get("agent") != "claude-code" || query.Get("sessionId") != "sess-query" {
		t.Fatalf("prompt query natural key = %q/%q", query.Get("agent"), query.Get("sessionId"))
	}
	if query.Get("scope") != "work" {
		t.Fatalf("scope = %q, want work", query.Get("scope"))
	}
	// The project facet is derived from cwd and must never be the literal
	// "unknown" deriveProject returns for an empty one.
	if project := query.Get("project"); project == "" || project == "unknown" {
		t.Fatalf("project facet = %q", project)
	}
}

// TestDebriefPromptQueryOmitsAnUnsetScope: an operator who never set
// THREENGRAM_SCOPE must not have an empty string sent as a facet — the prompt
// renders an absent key as "use the scope the work belonged to", while
// `scope=""` is a 400.
func TestDebriefPromptQueryOmitsAnUnsetScope(t *testing.T) {
	var captured atomicQuery
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/prompts/debrief":
			captured.set(r.URL.Query())
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(promptBody(testPrompt)))
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = fmt.Fprintf(w, `{"sessionRunId":%q,"armed":true,"attemptId":%q,"triageStatus":"pending",`+
				`"activationEpoch":1,"lastSeenAt":"2026-08-23T00:00:00Z","resurrected":false}`,
				testRunID, testAttemptID)
		}
	}))
	t.Cleanup(srv.Close)

	isolateCwd(t)
	t.Setenv("THREENGRAM_API_BASE", srv.URL)
	t.Setenv("THREENGRAM_API_KEY", "3ng_test")
	t.Setenv("THREENGRAM_HOOK_ROLE", "")
	t.Setenv("THREENGRAM_AGENT", "claude-code")
	t.Setenv("THREENGRAM_STOP_NUDGE", "1")
	t.Setenv("THREENGRAM_SCOPE", "   ")

	captureHook(t, stopPayload("sess-noscope", false), func() int { return runStop(nil) })

	if _, present := captured.get()["scope"]; present {
		t.Fatalf("an unset scope was sent: %v", captured.get())
	}
}

// TestContinuationEnvelopeEscapesTheText is the unit pin on pass-through. The
// prompt is server-authored and its tenant-supplied values are already fenced;
// the hook's only job is to not corrupt it. A reason that came back unequal
// after a JSON round trip would mean the hook became a second author of a string
// whose defenses were designed as a whole.
func TestContinuationEnvelopeEscapesTheText(t *testing.T) {
	hostile := "line\nbreak \"quoted\" ```fence``` \\backslash\\ \t tab sep"

	encoded, err := continuationEnvelope(codexAgent, hostile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "\n") {
		t.Fatalf("a raw newline reached the envelope, which is one JSON line: %s", encoded)
	}

	var round stopDecision
	if err := json.Unmarshal(encoded, &round); err != nil {
		t.Fatalf("envelope does not parse: %v\n%s", err, encoded)
	}
	if round.Reason != hostile {
		t.Fatalf("text changed in transit:\n got: %q\nwant: %q", round.Reason, hostile)
	}
	if round.Decision != "block" {
		t.Fatalf("decision = %q", round.Decision)
	}
}

// TestMaxInjectionsPerAttempt documents the cap as a number, so a change to it
// is a deliberate edit rather than a drift. One injection per attempt is what
// `begin` enforces by arming exactly once; the hook does not get a second.
func TestMaxInjectionsPerAttempt(t *testing.T) {
	if maxInjectionsPerAttempt != 1 {
		t.Fatalf("maxInjectionsPerAttempt = %d; the cap analysis in nudge.go assumes 1",
			maxInjectionsPerAttempt)
	}
}

// mustJSONString renders a Go string as a JSON string literal, for the golden
// envelope comparisons.
func mustJSONString(s string) string {
	encoded, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

// atomicQuery is a race-free holder for the query the handler saw. The hook
// makes its calls from the test goroutine but the handler runs on the server's,
// so the read needs the same lock the write took (go test -race).
type atomicQuery struct {
	mu    sync.Mutex
	value url.Values
}

func (a *atomicQuery) set(v url.Values) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.value = v
}

func (a *atomicQuery) get() url.Values {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.value
}
