// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestCommitmentsListProjectSelector(t *testing.T) {
	s := newReadServer(t)
	s.json("/api/v1/me", 200, meBody)
	due := item(2, "Ship the panel")
	due.dueAt, due.overdue = "2026-10-01T00:00:00.000Z", true
	s.json("/api/v1/briefing", 200, briefingBody(projectSel("demo"),
		section(2, item(1, "Write the spike"), due), section(1, due)))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--json")

	if r.code != 0 || !r.env.OK {
		t.Fatalf("code=%d env=%s", r.code, r.stdout)
	}
	ctx := r.env.Context
	if ctx.Requested.Kind != "project" || ctx.Requested.Project != "demo" || ctx.Project.Source != projectSourceDirectory {
		t.Fatalf("requested context = %+v", ctx)
	}
	if ctx.Account == nil || ctx.Account.Email != "owner@example.test" {
		t.Fatalf("account = %+v", ctx.Account)
	}
	if len(rowsOf(r.env)) != 2 || r.env.Counts.OpenOrWaiting != 2 || r.env.Counts.Overdue != 1 {
		t.Fatalf("rows=%d counts=%+v", len(rowsOf(r.env)), r.env.Counts)
	}
	first, second := rowsOf(r.env)[0], rowsOf(r.env)[1]
	if first.DueAt != nil || first.Overdue || second.DueAt == nil || !second.Overdue {
		t.Fatalf("due/overdue not carried: %+v %+v", first, second)
	}
	for _, row := range rowsOf(r.env) {
		if row.Filing != filingProject || row.Ownership != unclearOwnership {
			t.Fatalf("row filing/ownership = %+v", row)
		}
	}
	if strings.Join(r.env.Missing, ",") != "owner,sourceSession" {
		t.Fatalf("missing = %v", r.env.Missing)
	}
	q := briefingQuery(t, s)
	for key, want := range map[string]string{"kind": "project", "project": "demo", "mode": "full", "sections": "commitments,overdue", "sectionLimit": "100"} {
		if q.Get(key) != want {
			t.Errorf("briefing %s = %q, want %q", key, q.Get(key), want)
		}
	}
	if q.Has("includeUnscoped") || q.Has("scope") {
		t.Errorf("a project read must not send scope keys: %v", q)
	}
}

func TestCommitmentsListScopeProjectIsStrictByDefault(t *testing.T) {
	s := newReadServer(t)
	s.json("/api/v1/me", 200, meBody)
	s.json("/api/v1/briefing", 200, briefingBody(scopeProjectSel("work", "demo", false), section(1, item(1, "a")), section(0)))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work")

	if !r.env.OK || s.count("/api/v1/briefing") != 1 || s.count("/api/v1/memories/"+uuidFor("m", 1)) != 0 {
		t.Fatalf("a strict read needs one briefing and no filing lookups: %s", r.stdout)
	}
	q := briefingQuery(t, s)
	if q.Get("kind") != "scope_project" || q.Get("scope") != "work" || q.Get("includeUnscoped") != "false" {
		t.Fatalf("query = %v", q)
	}
}

func TestCommitmentsListIncludeUnscopedRequiresScope(t *testing.T) {
	s := newReadServer(t)

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--include-unscoped")

	if r.code != 1 || r.env.OK || r.env.Error.Kind != kindInvalidSelector {
		t.Fatalf("code=%d env=%s", r.code, r.stdout)
	}
	if n := len(s.recorded()); n != 0 {
		t.Fatalf("an invalid selector must make zero requests, made %d", n)
	}
}

func TestCommitmentsListNoKeyMakesNoRequest(t *testing.T) {
	s := newReadServer(t)
	t.Setenv("THREENGRAM_API_KEY", "")

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list")

	if r.code != 1 || r.env.Error.Kind != kindNoKey || r.env.Context.Fingerprint == "" {
		t.Fatalf("code=%d env=%s", r.code, r.stdout)
	}
	if n := len(s.recorded()); n != 0 {
		t.Fatalf("no_key must make zero requests, made %d", n)
	}
}

func TestCommitmentsListRejectsAWiderEcho(t *testing.T) {
	for name, echo := range map[string]map[string]any{
		"widened":       scopeProjectSel("work", "demo", true),
		"other project": scopeProjectSel("work", "other", false),
		"other kind":    {"kind": "scope", "scope": "work"},
	} {
		t.Run(name, func(t *testing.T) {
			s := newReadServer(t)
			s.json("/api/v1/me", 200, meBody)
			s.json("/api/v1/briefing", 200, briefingBody(echo, section(1, item(1, "leak?")), section(0)))

			r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work")

			if r.code != 2 || r.env.Error.Kind != kindSelectorMismatch || r.env.Commitments != nil {
				t.Fatalf("code=%d env=%s", r.code, r.stdout)
			}
			if strings.Contains(r.stdout, "leak?") {
				t.Fatal("a mismatched read must not emit its rows")
			}
		})
	}
}

func TestCommitmentsListAccountFailureIsPartial(t *testing.T) {
	s := newReadServer(t)
	s.json("/api/v1/me", 503, `{"error":"unavailable","detail":"topic: Ship the panel"}`)
	s.json("/api/v1/briefing", 200, briefingBody(projectSel("demo"), section(1, item(1, "Ship the panel")), section(0)))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list")

	if !r.env.OK || r.env.Context.Account != nil {
		t.Fatalf("env = %s", r.stdout)
	}
	if !hasPartial(r.env, "account", kindUnavailable) {
		t.Fatalf("partial = %+v", r.env.Partial)
	}
	if strings.Contains(r.stderr, "Ship the panel") || !strings.Contains(r.stderr, "me: unavailable (503)") {
		t.Fatalf("stderr must name route and status only: %q", r.stderr)
	}
}

func TestCommitmentsListLabelsTruncation(t *testing.T) {
	s := newReadServer(t)
	s.json("/api/v1/me", 200, meBody)
	s.json("/api/v1/briefing", 200, briefingBody(projectSel("demo"), section(140, item(1, "a"), item(2, "b")), section(0)))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list")

	if r.env.Counts.OpenOrWaiting != 140 || r.env.Counts.Returned != 2 {
		t.Fatalf("counts = %+v", r.env.Counts)
	}
	found := false
	for _, p := range r.env.Partial {
		if p.Part == "commitments" && p.Reason == "truncated" && p.Returned != nil && *p.Returned == 2 && p.Total != nil && *p.Total == 140 {
			found = true
		}
	}
	if !found {
		t.Fatalf("truncation not labelled: %+v", r.env.Partial)
	}
}

// The strict slice is bounded: a project row it truncated is absent from it.
// Absence must lead to a lookup, never to an `unscoped` label.
func TestCommitmentsListVerifiesUnscopedUnderTruncation(t *testing.T) {
	s := newReadServer(t)
	s.json("/api/v1/me", 200, meBody)
	a, b, c := item(1, "kept by strict"), item(2, "cut from strict"), item(3, "really unscoped")
	s.json("/api/v1/briefing?includeUnscoped=true", 200, briefingBody(scopeProjectSel("work", "demo", true), section(3, a, b, c), section(0)))
	s.json("/api/v1/briefing?includeUnscoped=false", 200, briefingBody(scopeProjectSel("work", "demo", false), section(2, a), section(0)))
	s.json("/api/v1/memories/"+b.memoryID, 200, memoryBodyFor(b.memoryID, "work", strPtr("demo"), "active", nil))
	s.json("/api/v1/memories/"+c.memoryID, 200, memoryBodyFor(c.memoryID, "work", nil, "active", nil))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work", "--include-unscoped")

	got := filings(r.env)
	if got[a.memoryID] != filingProject || got[b.memoryID] != filingProject || got[c.memoryID] != filingUnscoped {
		t.Fatalf("filings = %v", got)
	}
	if s.count("/api/v1/memories/"+a.memoryID) != 0 {
		t.Fatal("a row the strict read returned needs no lookup")
	}
	if strings.Contains(r.stdout, "SECRET CONTENT") {
		t.Fatal("a filing lookup must not leak the memory's content")
	}
}

func TestCommitmentsListFilingChangesDuringRead(t *testing.T) {
	s := newReadServer(t)
	s.json("/api/v1/me", 200, meBody)
	moved, failed, superseded, rescoped, vanished := item(1, "moved"), item(2, "lookup fails"), item(3, "superseded"), item(4, "rescoped"), item(5, "vanished")
	s.json("/api/v1/briefing?includeUnscoped=true", 200, briefingBody(scopeProjectSel("work", "demo", true),
		section(5, moved, failed, superseded, rescoped, vanished), section(0)))
	s.json("/api/v1/briefing?includeUnscoped=false", 200, briefingBody(scopeProjectSel("work", "demo", false), section(0), section(0)))
	s.json("/api/v1/memories/"+moved.memoryID, 200, memoryBodyFor(moved.memoryID, "work", strPtr("elsewhere"), "active", nil))
	s.json("/api/v1/memories/"+failed.memoryID, 500, `{"error":"internal"}`)
	s.json("/api/v1/memories/"+superseded.memoryID, 200, memoryBodyFor(superseded.memoryID, "work", nil, "active", strPtr("2026-10-07T00:00:00.000Z")))
	s.json("/api/v1/memories/"+rescoped.memoryID, 200, memoryBodyFor(rescoped.memoryID, "personal", nil, "active", nil))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work", "--include-unscoped")

	got := filings(r.env)
	if len(got) != 1 || got[failed.memoryID] != filingUnknown {
		t.Fatalf("only the failed lookup may remain, as unknown: %v", got)
	}
	if r.env.Counts.ChangedDuringRead != 4 {
		t.Fatalf("changedDuringRead = %d", r.env.Counts.ChangedDuringRead)
	}
	if !hasPartial(r.env, "filing", kindUnavailable) {
		t.Fatalf("partial = %+v", r.env.Partial)
	}
	for _, topic := range []string{"moved", "superseded", "rescoped", "vanished"} {
		if strings.Contains(r.stdout, `"`+topic+`"`) {
			t.Fatalf("row %q left the selector and must not be emitted", topic)
		}
	}
}

func TestCommitmentsListStrictReadFailureVerifiesEveryRow(t *testing.T) {
	s := newReadServer(t)
	s.json("/api/v1/me", 200, meBody)
	a := item(1, "a")
	s.json("/api/v1/briefing?includeUnscoped=true", 200, briefingBody(scopeProjectSel("work", "demo", true), section(1, a), section(0)))
	s.json("/api/v1/briefing?includeUnscoped=false", 503, `{"error":"unavailable"}`)
	s.json("/api/v1/memories/"+a.memoryID, 200, memoryBodyFor(a.memoryID, "work", strPtr("demo"), "active", nil))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work", "--include-unscoped")

	if filings(r.env)[a.memoryID] != filingProject || !hasPartial(r.env, "filing", "strict_read_unavailable") {
		t.Fatalf("env = %s", r.stdout)
	}
}

func TestCommitmentsListDeadlineDuringFilingIsPartial(t *testing.T) {
	withDeadline(t, 300*time.Millisecond)
	s := newReadServer(t)
	s.json("/api/v1/me", 200, meBody)
	a := item(1, "slow lookup")
	s.json("/api/v1/briefing?includeUnscoped=true", 200, briefingBody(scopeProjectSel("work", "demo", true), section(1, a), section(0)))
	s.json("/api/v1/briefing?includeUnscoped=false", 200, briefingBody(scopeProjectSel("work", "demo", false), section(0), section(0)))
	s.handle("/api/v1/memories/"+a.memoryID, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	})

	start := time.Now()
	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work", "--include-unscoped")

	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("the operation outlived its deadline: %s", elapsed)
	}
	if !r.env.OK || filings(r.env)[a.memoryID] != filingUnknown || !hasPartial(r.env, "filing", kindTimeout) {
		t.Fatalf("env = %s", r.stdout)
	}
}

func TestCommitmentsListBriefingFailures(t *testing.T) {
	cases := map[string]struct {
		status int
		body   string
		slow   bool
		want   string
	}{
		"auth":         {status: 401, body: `{"error":"unauthorized"}`, want: kindAuth},
		"route":        {status: 404, body: `{"error":"not_found"}`, want: kindRouteMissing},
		"rate limited": {status: 429, body: `{"error":"rate_limited"}`, want: kindRateLimited},
		"unavailable":  {status: 503, body: `{"error":"unavailable"}`, want: kindUnavailable},
		"bad body":     {status: 200, body: `{not json`, want: kindBadResponse},
		"timeout":      {slow: true, want: kindTimeout},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			withDeadline(t, 200*time.Millisecond)
			s := newReadServer(t)
			s.json("/api/v1/me", 200, meBody)
			if tc.slow {
				s.handle("/api/v1/briefing", func(_ http.ResponseWriter, r *http.Request) {
					select {
					case <-r.Context().Done():
					case <-time.After(5 * time.Second):
					}
				})
			} else {
				s.json("/api/v1/briefing", tc.status, tc.body)
			}

			r := runCommitmentsForTest(t, projectDir(t, "demo"), "list")

			if r.code != 2 || r.env.OK || r.env.Error.Kind != tc.want {
				t.Fatalf("code=%d env=%s", r.code, r.stdout)
			}
			if r.env.Context.Fingerprint == "" || r.env.Context.Requested.Project != "demo" || r.env.Commitments != nil {
				t.Fatalf("an error envelope keeps its context and drops rows: %s", r.stdout)
			}
		})
	}
}

func TestCommitmentsContextIsLocalAndMatchesList(t *testing.T) {
	s := newReadServer(t)
	dir := projectDir(t, "demo")

	probe := runCommitmentsForTest(t, dir, "context", "--scope", "work")
	if probe.code != 0 || !probe.env.OK || len(s.recorded()) != 0 {
		t.Fatalf("context must succeed without a request: code=%d requests=%d", probe.code, len(s.recorded()))
	}

	s.json("/api/v1/me", 200, meBody)
	s.json("/api/v1/briefing", 200, briefingBody(scopeProjectSel("work", "demo", false), section(0), section(0)))
	list := runCommitmentsForTest(t, dir, "list", "--scope", "work")
	if list.env.Context.Fingerprint != probe.env.Context.Fingerprint {
		t.Fatalf("probe %s != list %s", probe.env.Context.Fingerprint, list.env.Context.Fingerprint)
	}

	t.Setenv("THREENGRAM_API_KEY", testAPIKey+"-rotated")
	rotated := runCommitmentsForTest(t, dir, "context", "--scope", "work")
	if rotated.env.Context.Fingerprint == probe.env.Context.Fingerprint {
		t.Fatal("a rotated key must change the fingerprint")
	}
}

func TestCommitmentsNeverPrintsTheKey(t *testing.T) {
	s := newReadServer(t)
	s.json("/api/v1/me", 401, `{"error":"unauthorized"}`)
	s.json("/api/v1/briefing", 401, `{"error":"unauthorized"}`)
	dir := projectDir(t, "demo")

	for _, args := range [][]string{{"list"}, {"context"}, {"list", "--scope", "work"}} {
		r := runCommitmentsForTest(t, dir, args...)
		if strings.Contains(r.stdout+r.stderr, "testsecret") || strings.Contains(r.stdout+r.stderr, "testprefix") {
			t.Fatalf("%v leaked the key: %s %s", args, r.stdout, r.stderr)
		}
	}
	for _, req := range s.recorded() {
		if req.Key != testAPIKey {
			t.Fatalf("request %s carried key %q", req.Path, req.Key)
		}
	}
}

func TestCommitmentsUsage(t *testing.T) {
	newReadServer(t)
	dir := projectDir(t, "demo")
	for _, args := range [][]string{{}, {"--scope", "x"}, {"delete"}, {"list", "--bogus"}, {"list", "extra"}} {
		r := runCommitmentsForTest(t, dir, args...)
		if r.code != 1 || r.env.Error == nil || r.env.Error.Kind != kindUsage {
			t.Fatalf("%v: code=%d env=%s", args, r.code, r.stdout)
		}
	}
}

func TestSelectorWithin(t *testing.T) {
	yes, no := true, false
	sp := func(scope, project string, include *bool) briefingSelector {
		return briefingSelector{Kind: "scope_project", Scope: scope, Project: project, IncludeUnscoped: include}
	}
	cases := []struct {
		name      string
		req, eff  briefingSelector
		wantWithn bool
	}{
		{"same strict", sp("w", "p", &no), sp("w", "p", &no), true},
		{"echo omits flag", sp("w", "p", &no), sp("w", "p", nil), true},
		{"request omits flag, echo widened", sp("w", "p", nil), sp("w", "p", &yes), false},
		{"narrowed", sp("w", "p", &yes), sp("w", "p", &no), true},
		{"widened", sp("w", "p", &no), sp("w", "p", &yes), false},
		{"other scope", sp("w", "p", &no), sp("x", "p", &no), false},
		{"project kind", briefingSelector{Kind: "project", Project: "p"}, briefingSelector{Kind: "project", Project: "p"}, true},
		{"kind changed", briefingSelector{Kind: "project", Project: "p"}, briefingSelector{Kind: "all"}, false},
	}
	for _, tc := range cases {
		if got := selectorWithin(tc.req, tc.eff); got != tc.wantWithn {
			t.Errorf("%s: selectorWithin = %v", tc.name, got)
		}
	}
}

func TestBuildBriefingQueryScopeProject(t *testing.T) {
	include := true
	got := buildBriefingQuery(briefingSelector{Kind: "scope_project", Scope: "work", Project: "demo", IncludeUnscoped: &include})
	if got != "?includeUnscoped=true&kind=scope_project&mode=full&project=demo&scope=work" {
		t.Fatalf("query = %s", got)
	}
}

// A strict read that answers under a wider selector must not decide filing:
// its rows could be unscoped, so every row is verified instead.
func TestCommitmentsListRejectsAWiderStrictEcho(t *testing.T) {
	s := newReadServer(t)
	s.json("/api/v1/me", 200, meBody)
	u := item(1, "unscoped but echoed as strict")
	s.json("/api/v1/briefing?includeUnscoped=true", 200, briefingBody(scopeProjectSel("work", "demo", true), section(1, u), section(0)))
	s.json("/api/v1/briefing?includeUnscoped=false", 200, briefingBody(scopeProjectSel("work", "demo", true), section(1, u), section(0)))
	s.json("/api/v1/memories/"+u.memoryID, 200, memoryBodyFor(u.memoryID, "work", nil, "active", nil))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work", "--include-unscoped")

	if got := filings(r.env)[u.memoryID]; got != filingUnscoped {
		t.Fatalf("filing = %q, want unscoped from the memory read", got)
	}
	if !hasPartial(r.env, "filing", "strict_read_selector_mismatch") {
		t.Fatalf("partial = %+v", r.env.Partial)
	}
}

func TestCommitmentsListEmptyKeepsAnExplicitList(t *testing.T) {
	s := newReadServer(t)
	s.json("/api/v1/me", 200, meBody)
	s.json("/api/v1/briefing", 200, briefingBody(projectSel("demo"), section(0), section(0)))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list")

	if !strings.Contains(r.stdout, `"commitments":[]`) || !strings.Contains(r.stdout, `"changedDuringRead":0`) {
		t.Fatalf("an empty ok list must say so explicitly: %s", r.stdout)
	}
}

func TestCommitmentsListZeroVerifiedIsCounted(t *testing.T) {
	withDeadline(t, 150*time.Millisecond)
	s := newReadServer(t)
	s.json("/api/v1/me", 200, meBody)
	a := item(1, "slow")
	s.json("/api/v1/briefing?includeUnscoped=true", 200, briefingBody(scopeProjectSel("work", "demo", true), section(1, a), section(0)))
	s.json("/api/v1/briefing?includeUnscoped=false", 200, briefingBody(scopeProjectSel("work", "demo", false), section(0), section(0)))
	s.handle("/api/v1/memories/"+a.memoryID, func(_ http.ResponseWriter, r *http.Request) { <-r.Context().Done() })

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work", "--include-unscoped")

	if !strings.Contains(r.stdout, `"part":"filing","reason":"timeout","returned":0,"total":1`) {
		t.Fatalf("0 of 1 verified must be explicit: %s", r.stdout)
	}
}

func TestCommitmentsListNeverPutsAMalformedIDInAPath(t *testing.T) {
	s := newReadServer(t)
	s.json("/api/v1/me", 200, meBody)
	bad := item(1, "hostile id")
	bad.memoryID = ".."
	s.json("/api/v1/briefing?includeUnscoped=true", 200, briefingBody(scopeProjectSel("work", "demo", true), section(1, bad), section(0)))
	s.json("/api/v1/briefing?includeUnscoped=false", 200, briefingBody(scopeProjectSel("work", "demo", false), section(0), section(0)))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work", "--include-unscoped")

	for _, req := range s.recorded() {
		if strings.HasPrefix(req.Path, "/api/v1/memories") {
			t.Fatalf("a malformed id reached a request path: %s", req.Path)
		}
	}
	if filings(r.env)[".."] != filingUnknown || !hasPartial(r.env, "filing", kindBadResponse) {
		t.Fatalf("env = %s", r.stdout)
	}
}

// One operation authenticates with one credential: a key file rotated while
// the operation runs must not make later reads use the new key.
func TestCommitmentsListPinsOneCredential(t *testing.T) {
	s := newReadServer(t)
	t.Setenv("THREENGRAM_API_KEY", "")
	keyFile := filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "3ngram", "api-key")
	if err := os.MkdirAll(filepath.Dir(keyFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, []byte("key-before-rotation"), 0o600); err != nil {
		t.Fatal(err)
	}
	a := item(1, "a")
	s.json("/api/v1/me", 200, meBody)
	s.handle("/api/v1/briefing?includeUnscoped=true", func(w http.ResponseWriter, _ *http.Request) {
		_ = os.WriteFile(keyFile, []byte("key-after-rotation"), 0o600)
		_, _ = w.Write([]byte(briefingBody(scopeProjectSel("work", "demo", true), section(1, a), section(0))))
	})
	s.json("/api/v1/briefing?includeUnscoped=false", 200, briefingBody(scopeProjectSel("work", "demo", false), section(0), section(0)))
	s.json("/api/v1/memories/"+a.memoryID, 200, memoryBodyFor(a.memoryID, "work", nil, "active", nil))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work", "--include-unscoped")

	if !r.env.OK || len(s.recorded()) != 4 {
		t.Fatalf("env=%s requests=%d", r.stdout, len(s.recorded()))
	}
	for _, req := range s.recorded() {
		if req.Key != "key-before-rotation" {
			t.Fatalf("%s authenticated with %q after the rotation", req.Path, req.Key)
		}
	}
}

func TestCommitmentsListRejectsAnIncompleteBriefing(t *testing.T) {
	for name, body := range map[string]string{
		"no sections":   `{"selector":{"kind":"project","project":"demo"},"mode":"full","generatedAt":"x"}`,
		"no items":      `{"selector":{"kind":"project","project":"demo"},"commitments":{"count":3},"overdue":{"count":0,"items":[]}}`,
		"no count":      `{"selector":{"kind":"project","project":"demo"},"commitments":{"items":[]},"overdue":{"count":0,"items":[]}}`,
		"null sections": `{"selector":{"kind":"project","project":"demo"},"commitments":null,"overdue":null}`,
	} {
		t.Run(name, func(t *testing.T) {
			s := newReadServer(t)
			s.json("/api/v1/me", 200, meBody)
			s.json("/api/v1/briefing", 200, body)

			r := runCommitmentsForTest(t, projectDir(t, "demo"), "list")

			if r.code != 2 || r.env.OK || r.env.Error.Kind != kindBadResponse || r.env.Commitments != nil {
				t.Fatalf("an incomplete 200 must not read as an empty list: code=%d %s", r.code, r.stdout)
			}
		})
	}
}

// The strict read starts only after the widened read answered, so a row it
// returns describes the filing at or after the widened read.
func TestCommitmentsListReadsStrictAfterWidened(t *testing.T) {
	s := newReadServer(t)
	var widenedDone atomic.Bool
	s.json("/api/v1/me", 200, meBody)
	s.handle("/api/v1/briefing?includeUnscoped=true", func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(50 * time.Millisecond)
		_, _ = w.Write([]byte(briefingBody(scopeProjectSel("work", "demo", true), section(0), section(0))))
		widenedDone.Store(true)
	})
	s.handle("/api/v1/briefing?includeUnscoped=false", func(w http.ResponseWriter, _ *http.Request) {
		if !widenedDone.Load() {
			t.Error("the strict read started before the widened read answered")
		}
		_, _ = w.Write([]byte(briefingBody(scopeProjectSel("work", "demo", false), section(0), section(0))))
	})

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work", "--include-unscoped")

	if !r.env.OK {
		t.Fatalf("env = %s", r.stdout)
	}
}

func TestCommitmentsResolvesARelativeCwd(t *testing.T) {
	newReadServer(t)
	t.Chdir(projectDir(t, "relative-demo"))

	r := runCommitmentsForTest(t, "/somewhere/else", "context", "--cwd", ".")

	if r.env.Context.Project.Name != "relative-demo" {
		t.Fatalf("project = %+v", r.env.Context.Project)
	}
}

// The deadline covers project derivation: a git that stalls ends the
// operation with a timeout envelope instead of outliving the plugin's ceiling
// or silently falling back to the directory name.
func TestCommitmentsDeadlineCoversProjectDerivation(t *testing.T) {
	withDeadline(t, 200*time.Millisecond)
	newReadServer(t)
	bin := t.TempDir()
	stall := "#!/bin/sh\nexec sleep 5\n"
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(stall), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	start := time.Now()
	r := runCommitmentsForTest(t, projectDir(t, "demo"), "context")

	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("project derivation outlived the deadline: %s", elapsed)
	}
	if r.env.OK || r.env.Error.Kind != kindTimeout || r.env.Context.Project.Name == "demo" {
		t.Fatalf("a stalled git must time out, not fall back: %s", r.stdout)
	}
}

// project and validTo are required but nullable. An answer that omits one says
// nothing about the filing: it is never read as null (which would mean
// unscoped, or live).
func TestCommitmentsListOmittedFilingFieldsAreUnknown(t *testing.T) {
	for _, field := range []string{"project", "validTo"} {
		t.Run(field, func(t *testing.T) {
			s := newReadServer(t)
			s.json("/api/v1/me", 200, meBody)
			a := item(1, "answer without "+field)
			s.json("/api/v1/briefing?includeUnscoped=true", 200, briefingBody(scopeProjectSel("work", "demo", true), section(1, a), section(0)))
			s.json("/api/v1/briefing?includeUnscoped=false", 200, briefingBody(scopeProjectSel("work", "demo", false), section(0), section(0)))
			var body map[string]any
			_ = json.Unmarshal([]byte(memoryBodyFor(a.memoryID, "work", nil, "active", nil)), &body)
			delete(body, field)
			s.json("/api/v1/memories/"+a.memoryID, 200, mustMarshal(body))

			r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work", "--include-unscoped")

			if filings(r.env)[a.memoryID] != filingUnknown || !hasPartial(r.env, "filing", kindBadResponse) {
				t.Fatalf("env = %s", r.stdout)
			}
		})
	}
}

// A commitment resolved between the widened and the strict read is still an
// active, current memory; its commitment status is what says it left the list.
func TestCommitmentsListDropsACommitmentResolvedDuringTheRead(t *testing.T) {
	s := newReadServer(t)
	s.json("/api/v1/me", 200, meBody)
	a := item(1, "resolved meanwhile")
	s.json("/api/v1/briefing?includeUnscoped=true", 200, briefingBody(scopeProjectSel("work", "demo", true), section(1, a), section(0)))
	s.json("/api/v1/briefing?includeUnscoped=false", 200, briefingBody(scopeProjectSel("work", "demo", false), section(0), section(0)))
	s.json("/api/v1/memories/"+a.memoryID, 200, strings.Replace(memoryBodyFor(a.memoryID, "work", nil, "active", nil), `"commitmentStatus":"open"`, `"commitmentStatus":"resolved"`, 1))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work", "--include-unscoped")

	if len(rowsOf(r.env)) != 0 || r.env.Counts.ChangedDuringRead != 1 {
		t.Fatalf("env = %s", r.stdout)
	}
}

// Reading the key file is bounded by the deadline too: a file that blocks
// (here a FIFO nobody writes) ends the operation with a timeout envelope.
func TestCommitmentsDeadlineCoversKeyResolution(t *testing.T) {
	withDeadline(t, 200*time.Millisecond)
	newReadServer(t)
	t.Setenv("THREENGRAM_API_KEY", "")
	keyFile := filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "3ngram", "api-key")
	if err := os.MkdirAll(filepath.Dir(keyFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(keyFile, 0o600); err != nil {
		t.Fatal(err)
	}
	// Unblock the stalled read when the test ends, so no goroutine is left.
	t.Cleanup(func() {
		if f, err := os.OpenFile(keyFile, os.O_WRONLY|syscall.O_NONBLOCK, 0); err == nil {
			_ = f.Close()
		}
	})

	start := time.Now()
	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list")

	if time.Since(start) > 2*time.Second {
		t.Fatalf("key resolution outlived the deadline")
	}
	if r.env.OK || r.env.Error.Kind != kindTimeout {
		t.Fatalf("env = %s", r.stdout)
	}
}

// A filing answer for another memory says nothing about this row.
func TestCommitmentsListFilingAnswerForAnotherIDIsUnknown(t *testing.T) {
	s := newReadServer(t)
	s.json("/api/v1/me", 200, meBody)
	a := item(1, "answered for another id")
	s.json("/api/v1/briefing?includeUnscoped=true", 200, briefingBody(scopeProjectSel("work", "demo", true), section(1, a), section(0)))
	s.json("/api/v1/briefing?includeUnscoped=false", 200, briefingBody(scopeProjectSel("work", "demo", false), section(0), section(0)))
	s.json("/api/v1/memories/"+a.memoryID, 200, memoryBodyFor(uuidFor("m", 99), "work", nil, "active", nil))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work", "--include-unscoped")

	if filings(r.env)[a.memoryID] != filingUnknown || !hasPartial(r.env, "filing", kindBadResponse) {
		t.Fatalf("env = %s", r.stdout)
	}
}

// A missing or unrecognised commitment status keeps the row as unknown; only
// a status the briefing filter excludes (resolved, expired) drops it.
func TestCommitmentsListCommitmentStatusDecidesOnlyWhenKnown(t *testing.T) {
	cases := map[string]struct {
		status  string
		filing  string
		dropped bool
	}{
		"waiting":      {status: "waiting", filing: filingUnscoped},
		"expired":      {status: "expired", dropped: true},
		"missing":      {status: "", filing: filingUnknown},
		"unrecognised": {status: "snoozed", filing: filingUnknown},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			s := newReadServer(t)
			s.json("/api/v1/me", 200, meBody)
			a := item(1, "status "+name)
			s.json("/api/v1/briefing?includeUnscoped=true", 200, briefingBody(scopeProjectSel("work", "demo", true), section(1, a), section(0)))
			s.json("/api/v1/briefing?includeUnscoped=false", 200, briefingBody(scopeProjectSel("work", "demo", false), section(0), section(0)))
			var body map[string]any
			_ = json.Unmarshal([]byte(memoryBodyFor(a.memoryID, "work", nil, "active", nil)), &body)
			if tc.status == "" {
				delete(body, "commitmentStatus")
			} else {
				body["commitmentStatus"] = tc.status
			}
			s.json("/api/v1/memories/"+a.memoryID, 200, mustMarshal(body))

			r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work", "--include-unscoped")

			if tc.dropped {
				if len(rowsOf(r.env)) != 0 || r.env.Counts.ChangedDuringRead != 1 {
					t.Fatalf("env = %s", r.stdout)
				}
				return
			}
			if got := filings(r.env)[a.memoryID]; got != tc.filing || r.env.Counts.ChangedDuringRead != 0 {
				t.Fatalf("filing = %q, env = %s", got, r.stdout)
			}
		})
	}
}

func mustMarshal(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func briefingQuery(t *testing.T, s *readServer) url.Values {
	t.Helper()
	for _, r := range s.recorded() {
		if r.Path == "/api/v1/briefing" {
			q, err := url.ParseQuery(r.Query)
			if err != nil {
				t.Fatal(err)
			}
			return q
		}
	}
	t.Fatal("no briefing request")
	return nil
}

func rowsOf(env commitmentsEnvelope) []commitmentRow {
	if env.Commitments == nil {
		return nil
	}
	return *env.Commitments
}

func filings(env commitmentsEnvelope) map[string]string {
	out := map[string]string{}
	for _, row := range rowsOf(env) {
		out[row.MemoryID] = row.Filing
	}
	return out
}

func hasPartial(env commitmentsEnvelope, part, reason string) bool {
	for _, p := range env.Partial {
		if p.Part == part && p.Reason == reason {
			return true
		}
	}
	return false
}
