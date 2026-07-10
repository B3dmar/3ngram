// SPDX-License-Identifier: Apache-2.0
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// TestRunBriefingSubagentRoleSkipsAutoPull asserts that when THREENGRAM_HOOK_ROLE
// is "subagent", runBriefing early-returns 0 without issuing any briefing
// auto-pull request, even from the primary worktree. A Task-dispatched sub-agent
// inherits the main worktree cwd, so the path-based secondary-worktree check
// alone would not suppress the pull; the role gate must.
func TestRunBriefingSubagentRoleSkipsAutoPull(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(srv.Close)

	t.Setenv("THREENGRAM_API_BASE", srv.URL)
	t.Setenv("THREENGRAM_API_KEY", "3ng_test")
	t.Setenv("THREENGRAM_HOOK_ROLE", "subagent")

	if rc := runBriefing(); rc != 0 {
		t.Fatalf("runBriefing() returned %d, want 0", rc)
	}
	if got := hits.Load(); got != 0 {
		t.Fatalf("expected no auto-pull requests, got %d", got)
	}
}

func TestDeriveBriefingSelector(t *testing.T) {
	t.Run("defaults to project when resolved", func(t *testing.T) {
		t.Setenv("THREENGRAM_BRIEFING_KIND", "")
		s := deriveBriefingSelector("3ngram")
		if s.Kind != "project" || s.Project != "3ngram" {
			t.Fatalf("got %+v, want {project, 3ngram}", s)
		}
	})
	t.Run("falls back to all for unknown project", func(t *testing.T) {
		t.Setenv("THREENGRAM_BRIEFING_KIND", "")
		s := deriveBriefingSelector("unknown")
		if s.Kind != "all" {
			t.Fatalf("got %+v, want kind=all", s)
		}
	})
	t.Run("explicit all override", func(t *testing.T) {
		t.Setenv("THREENGRAM_BRIEFING_KIND", "all")
		s := deriveBriefingSelector("3ngram")
		if s.Kind != "all" {
			t.Fatalf("got %+v, want kind=all", s)
		}
	})
	t.Run("scope kind reads THREENGRAM_SCOPE", func(t *testing.T) {
		t.Setenv("THREENGRAM_BRIEFING_KIND", "scope")
		t.Setenv("THREENGRAM_SCOPE", "work")
		s := deriveBriefingSelector("3ngram")
		if s.Kind != "scope" || s.Scope != "work" {
			t.Fatalf("got %+v, want {scope, work}", s)
		}
	})
}

func TestBuildBriefingQuery(t *testing.T) {
	cases := []struct {
		sel  briefingSelector
		want string
	}{
		{briefingSelector{Kind: "all"}, "?kind=all"},
		{briefingSelector{Kind: "project", Project: "3ngram"}, "?kind=project&project=3ngram"},
		{briefingSelector{Kind: "scope", Scope: "work"}, "?kind=scope&scope=work"},
	}
	for _, tc := range cases {
		if got := buildBriefingQuery(tc.sel); got != tc.want {
			t.Errorf("buildBriefingQuery(%+v) = %q, want %q", tc.sel, got, tc.want)
		}
	}
}

func TestFormatCommitmentsEmpty(t *testing.T) {
	if got := formatCommitments(commitmentSection{}); got != "None" {
		t.Errorf("expected None, got %q", got)
	}
}

func TestFormatCommitments(t *testing.T) {
	section := commitmentSection{
		Count: 2,
		Items: []briefingCommitment{
			{Topic: "Ship v1", Status: "open", DueAt: "2026-06-15T00:00:00Z", Overdue: true},
			{Topic: "Fix auth", Status: "open"},
		},
	}
	got := formatCommitments(section)
	if !strings.Contains(got, "- **Ship v1** (open) due 2026-06-15T00:00:00Z [overdue]") {
		t.Errorf("missing first commitment in:\n%s", got)
	}
	if !strings.Contains(got, "- **Fix auth** (open)") {
		t.Errorf("missing second commitment in:\n%s", got)
	}
}

func TestFormatCommitmentsMore(t *testing.T) {
	section := commitmentSection{
		Count: 5,
		Items: []briefingCommitment{{Topic: "One", Status: "open"}},
	}
	got := formatCommitments(section)
	if !strings.Contains(got, "...and 4 more") {
		t.Errorf("expected overflow marker in:\n%s", got)
	}
}

func TestFormatMemoriesEmpty(t *testing.T) {
	if got := formatMemories(memorySection{}); got != "None" {
		t.Errorf("expected None, got %q", got)
	}
}

func TestFormatMemories(t *testing.T) {
	section := memorySection{
		Count: 1,
		Items: []briefingMemoryItem{
			{Topic: "Use composite FKs", MemoryType: "decision"},
		},
	}
	got := formatMemories(section)
	if !strings.Contains(got, "- **Use composite FKs** (decision)") {
		t.Errorf("missing memory line in:\n%s", got)
	}
}

func TestRunBriefingRendersRichOutput(t *testing.T) {
	body := `{
		"selector": {"kind": "project", "project": "3ngram"},
		"mode": "brief",
		"generatedAt": "2026-06-10T00:00:00Z",
		"commitments": {"count": 1, "items": [{"id":"a","memoryId":"b","topic":"Land hook","status":"open","dueAt":null,"overdue":false}]},
		"overdue": {"count": 0, "items": []},
		"blockers": {"count": 1, "items": [{"id":"c","memoryType":"blocker","topic":"CI flake","scope":"work","project":"3ngram","recordedAt":"2026-06-09T00:00:00Z","updatedAt":"2026-06-09T00:00:00Z"}]},
		"staleCandidates": {"count": 0, "items": []},
		"recentDecisions": {"count": 0, "items": []},
		"preferences": {"count": 0, "items": []}
	}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/briefing" {
			http.Error(w, "wrong path", http.StatusBadRequest)
			return
		}
		if r.URL.Query().Get("kind") == "" {
			http.Error(w, "missing kind selector", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)

	t.Setenv("THREENGRAM_API_BASE", srv.URL)
	t.Setenv("THREENGRAM_API_KEY", "3ng_test")
	t.Setenv("THREENGRAM_HOOK_ROLE", "")
	t.Setenv("THREENGRAM_BRIEFING_KIND", "all")

	if rc := runBriefing(); rc != 0 {
		t.Fatalf("runBriefing() returned %d, want 0", rc)
	}
}

func TestEnvInt(t *testing.T) {
	t.Setenv("TEST_INT", "42")
	if v := envInt("TEST_INT", 10); v != 42 {
		t.Errorf("expected 42, got %d", v)
	}
	if v := envInt("NONEXISTENT", 10); v != 10 {
		t.Errorf("expected default 10, got %d", v)
	}
	t.Setenv("TEST_INT_BAD", "not-a-number")
	if v := envInt("TEST_INT_BAD", 10); v != 10 {
		t.Errorf("expected default 10 for bad input, got %d", v)
	}
}
