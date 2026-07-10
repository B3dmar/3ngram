// SPDX-License-Identifier: Apache-2.0
package main

import (
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
