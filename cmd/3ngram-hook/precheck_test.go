// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestPrecheckProjectMatchesRepoRoot pins the P2b fix: a precheck launched from a
// subdirectory must resolve to the SAME project as the capture path (deriveProject,
// origin-remote based), not the subdir's basename. We exercise deriveProject from
// both the repo root and a nested subdir and assert they agree on the origin name.
func TestPrecheckProjectMatchesRepoRoot(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	repo := t.TempDir()
	gitInit(t, repo)
	run := exec.Command("git", "-C", repo, "remote", "add", "origin", "git@github.com:B3dmar/3ngram.git")
	if out, err := run.CombinedOutput(); err != nil {
		t.Fatalf("remote add: %v\n%s", err, out)
	}

	sub := filepath.Join(repo, "cmd", "3ngram-hook")
	if err := os.MkdirAll(sub, 0755); err != nil {
		t.Fatal(err)
	}

	const want = "3ngram"
	if got := deriveProject(repo); got != want {
		t.Errorf("deriveProject(root) = %q, want %q", got, want)
	}
	if got := deriveProject(sub); got != want {
		t.Errorf("deriveProject(subdir) = %q, want %q (subdir must not yield basename)", got, want)
	}
}

func TestPrecheckTopicStem(t *testing.T) {
	cases := []struct {
		name   string
		input  string
		want   string
		wantOk bool
	}{
		{"go file in src", "/repo/cmd/3ngram-hook/precheck.go", "precheck", true},
		{"ts file nested", "apps/server/src/rest/router.ts", "router", true},
		{"no extension", "scripts/setup", "setup", true},
		{"root file rejected", "README.md", "", false},
		{"dotfile rejected", "apps/server/.env", "", false},
		{"empty input rejected", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stem, ok := precheckTopicStem(tc.input)
			if ok != tc.wantOk {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOk)
			}
			if stem != tc.want {
				t.Errorf("stem = %q, want %q", stem, tc.want)
			}
		})
	}
}

func TestPrecheckPatchFilePaths(t *testing.T) {
	cases := []struct {
		name    string
		command string
		want    []string
	}{
		{
			name:    "update file",
			command: "*** Begin Patch\n*** Update File: apps/server/src/router.ts\n@@\n*** End Patch",
			want:    []string{"apps/server/src/router.ts"},
		},
		{
			name:    "add file",
			command: "*** Begin Patch\n*** Add File: packages/core/src/new-memory.ts\n+content\n*** End Patch",
			want:    []string{"packages/core/src/new-memory.ts"},
		},
		{
			name:    "all files in order",
			command: "*** Begin Patch\n*** Delete File: old.ts\n*** Add File: nested/new.ts\n*** End Patch",
			want:    []string{"old.ts", "nested/new.ts"},
		},
		{name: "invalid patch", command: "echo no patch", want: nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := precheckPatchFilePaths(tc.command)
			if len(got) != len(tc.want) {
				t.Fatalf("precheckPatchFilePaths() = %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("precheckPatchFilePaths()[%d] = %q, want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestParseToolInput(t *testing.T) {
	patch := "*** Begin Patch\n*** Update File: apps/server/src/router.ts\n*** End Patch"
	cases := []struct {
		name     string
		raw      string
		wantPath string
		wantCmd  string
	}{
		{
			name:     "claude object with file_path",
			raw:      `{"file_path":"cmd/3ngram-hook/precheck.go"}`,
			wantPath: "cmd/3ngram-hook/precheck.go",
			wantCmd:  "",
		},
		{
			name:     "codex structured object with command",
			raw:      `{"command":"` + strings.ReplaceAll(patch, "\n", `\n`) + `"}`,
			wantPath: "",
			wantCmd:  patch,
		},
		{
			name:     "codex freeform raw string",
			raw:      `"` + strings.ReplaceAll(patch, "\n", `\n`) + `"`,
			wantPath: "",
			wantCmd:  patch,
		},
		{name: "empty", raw: "", wantPath: "", wantCmd: ""},
		{name: "malformed", raw: "not json", wantPath: "", wantCmd: ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path, cmd := parseToolInput([]byte(tc.raw))
			if path != tc.wantPath {
				t.Fatalf("path = %q, want %q", path, tc.wantPath)
			}
			if cmd != tc.wantCmd {
				t.Fatalf("cmd = %q, want %q", cmd, tc.wantCmd)
			}
		})
	}
}

// TestPrecheckStemSkipsIneligibleHeader pins the P2 fix: a multi-file patch that
// starts with a repo-root file (rejected by precheckTopicStem) must not suppress
// the precheck — scanning continues to the nested source file and returns its stem.
func TestPrecheckStemSkipsIneligibleHeader(t *testing.T) {
	command := "*** Begin Patch\n*** Update File: README.md\n*** Update File: apps/server/src/router.ts\n*** End Patch"
	raw, err := json.Marshal(command)
	if err != nil {
		t.Fatal(err)
	}
	stem, ok := precheckStem("apply_patch", raw)
	if !ok {
		t.Fatal("expected an eligible stem from a later nested header, got none")
	}
	if stem != "router" {
		t.Fatalf("stem = %q, want %q (README.md header must be skipped)", stem, "router")
	}
}

func TestRenderPrecheckHookOutput(t *testing.T) {
	context := "3ngram: remember the router decision"
	got, err := renderPrecheckHookOutput(context)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, `"hookEventName":"PreToolUse"`) {
		t.Fatalf("missing PreToolUse event in %s", got)
	}
	if !strings.Contains(got, `"additionalContext":"3ngram: remember the router decision"`) {
		t.Fatalf("missing additional context in %s", got)
	}
}

// TestRunPrecheckApplyPatchEmitsHookOutput drives the full PreToolUse path end
// to end for a Codex apply_patch call: a raw payload on stdin (file under
// tool_input.command, not tool_input.file_path), a faked /api/v1/search backend
// (mirroring briefing_test.go), and an assertion on the hookSpecificOutput JSON
// written to stdout. It proves the apply_patch → patch-parse → search → hook-JSON
// chain wires together, not just the units in isolation.
func TestRunPrecheckApplyPatchEmitsHookOutput(t *testing.T) {
	searchBody := `{
		"count": 1,
		"hits": [
			{"id": "1", "memoryType": "decision", "topic": "router split", "content": "split the REST router into modules"}
		]
	}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/search" {
			http.Error(w, "wrong path", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(searchBody))
	}))
	t.Cleanup(srv.Close)

	t.Setenv("THREENGRAM_API_BASE", srv.URL)
	t.Setenv("THREENGRAM_API_KEY", "3ng_test")
	t.Setenv("THREENGRAM_PRECHECK_DISABLE", "")

	payload := `{"tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Update File: apps/server/src/router.ts\n@@\n*** End Patch"}}`

	out := captureRunPrecheck(t, payload)

	var got struct {
		HookSpecificOutput struct {
			HookEventName     string `json:"hookEventName"`
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("stdout is not valid hook JSON: %v\n%s", err, out)
	}
	if got.HookSpecificOutput.HookEventName != "PreToolUse" {
		t.Fatalf("hookEventName = %q, want PreToolUse", got.HookSpecificOutput.HookEventName)
	}
	ctx := got.HookSpecificOutput.AdditionalContext
	if !strings.Contains(ctx, "topic starting `router`") {
		t.Fatalf("additionalContext missing router stem header:\n%s", ctx)
	}
	if !strings.Contains(ctx, "router split") {
		t.Fatalf("additionalContext missing memory topic:\n%s", ctx)
	}
}

// TestRunPrecheckApplyPatchRawStringEmitsHookOutput drives the full PreToolUse
// path for Codex's FREEFORM apply_patch tool, whose tool_input is the raw patch
// STRING rather than an object with a command field. The previous struct-only
// decode failed on this shape and dropped the hook silently for every real
// freeform Codex patch; this proves the string→patch-parse→search→hook-JSON
// chain now wires together.
func TestRunPrecheckApplyPatchRawStringEmitsHookOutput(t *testing.T) {
	searchBody := `{
		"count": 1,
		"hits": [
			{"id": "1", "memoryType": "decision", "topic": "router split", "content": "split the REST router into modules"}
		]
	}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/search" {
			http.Error(w, "wrong path", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(searchBody))
	}))
	t.Cleanup(srv.Close)

	t.Setenv("THREENGRAM_API_BASE", srv.URL)
	t.Setenv("THREENGRAM_API_KEY", "3ng_test")
	t.Setenv("THREENGRAM_PRECHECK_DISABLE", "")

	// tool_input is the raw patch string itself (Codex freeform apply_patch).
	patch := "*** Begin Patch\n*** Update File: apps/server/src/router.ts\n@@\n*** End Patch"
	rawInput, err := json.Marshal(patch)
	if err != nil {
		t.Fatal(err)
	}
	payload := `{"tool_name":"apply_patch","tool_input":` + string(rawInput) + `}`

	out := captureRunPrecheck(t, payload)

	var got struct {
		HookSpecificOutput struct {
			HookEventName     string `json:"hookEventName"`
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("stdout is not valid hook JSON: %v\n%s", err, out)
	}
	if got.HookSpecificOutput.HookEventName != "PreToolUse" {
		t.Fatalf("hookEventName = %q, want PreToolUse", got.HookSpecificOutput.HookEventName)
	}
	ctx := got.HookSpecificOutput.AdditionalContext
	if !strings.Contains(ctx, "topic starting `router`") {
		t.Fatalf("additionalContext missing router stem header:\n%s", ctx)
	}
	if !strings.Contains(ctx, "router split") {
		t.Fatalf("additionalContext missing memory topic:\n%s", ctx)
	}
}

// TestRunPrecheckApplyPatchNoFileSilent pins the fire-and-forget invariant for
// apply_patch payloads whose command carries no recognizable
// Update/Add/Delete File header (e.g. a freeform shell-style apply_patch call,
// or a malformed patch): the hook must exit 0 and write nothing to stdout,
// never surfacing an empty or malformed hook envelope.
func TestRunPrecheckApplyPatchNoFileSilent(t *testing.T) {
	payload := `{"tool_name":"apply_patch","tool_input":{"command":"echo no file headers here"}}`

	out := captureRunPrecheck(t, payload)
	if out != "" {
		t.Fatalf("expected silent output for apply_patch with no file header, got %q", out)
	}
}

// TestRunPrecheckEditEmitsHookOutput mirrors the apply_patch e2e test for the
// pre-existing Claude Code Edit path (tool_input.file_path, not .command). The
// renderer switched from plain stdout to the hookSpecificOutput envelope for
// every matching tool, not just apply_patch — this proves that conversion end
// to end for existing Claude Code users, not just Codex's new path.
func TestRunPrecheckEditEmitsHookOutput(t *testing.T) {
	searchBody := `{
		"count": 1,
		"hits": [
			{"id": "2", "memoryType": "decision", "topic": "hook envelope", "content": "share the JSON envelope across Claude Code and Codex"}
		]
	}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/search" {
			http.Error(w, "wrong path", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(searchBody))
	}))
	t.Cleanup(srv.Close)

	t.Setenv("THREENGRAM_API_BASE", srv.URL)
	t.Setenv("THREENGRAM_API_KEY", "3ng_test")
	t.Setenv("THREENGRAM_PRECHECK_DISABLE", "")

	payload := `{"tool_name":"Edit","tool_input":{"file_path":"cmd/3ngram-hook/precheck.go"}}`

	out := captureRunPrecheck(t, payload)

	var got struct {
		HookSpecificOutput struct {
			HookEventName     string `json:"hookEventName"`
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("stdout is not valid hook JSON: %v\n%s", err, out)
	}
	if got.HookSpecificOutput.HookEventName != "PreToolUse" {
		t.Fatalf("hookEventName = %q, want PreToolUse", got.HookSpecificOutput.HookEventName)
	}
	ctx := got.HookSpecificOutput.AdditionalContext
	if !strings.Contains(ctx, "topic starting `precheck`") {
		t.Fatalf("additionalContext missing precheck stem header:\n%s", ctx)
	}
	if !strings.Contains(ctx, "hook envelope") {
		t.Fatalf("additionalContext missing memory topic:\n%s", ctx)
	}
}

// captureRunPrecheck drives runPrecheck with payload as stdin and returns
// everything it writes to stdout, faithful to how the hook runs in production
// (JSON in, hook JSON out).
func captureRunPrecheck(t *testing.T, payload string) string {
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

	if rc := runPrecheck(); rc != 0 {
		t.Fatalf("runPrecheck() = %d, want 0", rc)
	}
	_ = outW.Close()

	data, err := io.ReadAll(outR)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestRenderPrecheckSingular(t *testing.T) {
	resp := dashboardResponse{
		Items: []dashboardItem{
			{ID: 7, Topic: "memory_service refactor", Content: "split into modules", MemoryType: "decision"},
		},
		Total: 1,
	}
	got := renderPrecheck(resp, "memory_service", 3)
	if !strings.Contains(got, "3ngram: 1 memory with topic starting `memory_service`:") {
		t.Errorf("missing singular header in:\n%s", got)
	}
	if !strings.Contains(got, "- [7] **memory_service refactor** (decision): split into modules") {
		t.Errorf("missing item line in:\n%s", got)
	}
}

func TestRenderPrecheckPlural(t *testing.T) {
	resp := dashboardResponse{
		Items: []dashboardItem{
			{ID: 1, Topic: "main.py overhaul", Content: "moved routers"},
			{ID: 2, Topic: "main.py config", Content: "env var cleanup"},
		},
		Total: 2,
	}
	got := renderPrecheck(resp, "main", 3)
	if !strings.Contains(got, "3ngram: 2 memories with topic starting `main`:") {
		t.Errorf("missing plural header in:\n%s", got)
	}
}

func TestRenderPrecheckRespectsLimit(t *testing.T) {
	resp := dashboardResponse{
		Items: []dashboardItem{
			{ID: 1, Topic: "first"},
			{ID: 2, Topic: "second"},
			{ID: 3, Topic: "third"},
			{ID: 4, Topic: "fourth"},
		},
		Total: 4,
	}
	got := renderPrecheck(resp, "stem", 2)
	if strings.Contains(got, "third") || strings.Contains(got, "fourth") {
		t.Errorf("output exceeded limit=2:\n%s", got)
	}
	if !strings.Contains(got, "first") || !strings.Contains(got, "second") {
		t.Errorf("output missing limited items:\n%s", got)
	}
}

func TestRenderPrecheckTruncatesLongContent(t *testing.T) {
	long := strings.Repeat("x", 300)
	resp := dashboardResponse{
		Items: []dashboardItem{{ID: 1, Topic: "t", Content: long}},
		Total: 1,
	}
	got := renderPrecheck(resp, "stem", 3)
	if strings.Contains(got, long) {
		t.Errorf("content not truncated; output had full 300 chars")
	}
}
