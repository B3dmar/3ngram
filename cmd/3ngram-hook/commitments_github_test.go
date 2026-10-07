// SPDX-License-Identifier: Apache-2.0
package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// fakeGH is a STRICT stand-in for the gh CLI: it accepts exactly the one
// command shape the data path runs (`gh api --method GET
// repos/<owner>/<repo>/issues/<n>`, prompts disabled) and fails loudly on
// anything else, so a lookup that drifted from the real command cannot pass
// here. Responses come from testdata/github, captured from the real gh api.
const fakeGHScript = `#!/bin/sh
printf '%s\n' "$*" >> "$GH_FAKE_LOG"
if [ "$GH_PROMPT_DISABLED" != 1 ]; then echo "prompts not disabled" >&2; exit 65; fi
if [ $# -ne 4 ] || [ "$1" != api ] || [ "$2" != --method ] || [ "$3" != GET ]; then echo "unexpected argv: $*" >&2; exit 64; fi
case "$4" in repos/*/*/issues/*) ;; *) echo "unexpected path: $4" >&2; exit 64;; esac
if [ -n "$GH_FAKE_SLEEP" ]; then sleep "$GH_FAKE_SLEEP"; fi
if [ -f "$GH_FAKE_DIR/unauthenticated" ]; then echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4; fi
f="$GH_FAKE_DIR/$(printf %s "$4" | tr / _).json"
if [ -f "$f" ]; then cat "$f"; exit 0; fi
echo "gh: Not Found (HTTP 404)" >&2
exit 1
`

var realGHCall = regexp.MustCompile(`^api --method GET repos/[^/ ]+/[^/ ]+/issues/[0-9]+$`)

type fakeGitHub struct {
	t   *testing.T
	dir string
	log string
}

func installFakeGH(t *testing.T) *fakeGitHub {
	t.Helper()
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(fakeGHScript), 0o755); err != nil {
		t.Fatal(err)
	}
	fixtures := t.TempDir()
	matches, _ := filepath.Glob(filepath.Join("testdata", "github", "*.json"))
	for _, m := range matches {
		data, err := os.ReadFile(m)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(fixtures, filepath.Base(m)), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	f := &fakeGitHub{t: t, dir: fixtures, log: filepath.Join(t.TempDir(), "gh.log")}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("GH_FAKE_DIR", fixtures)
	t.Setenv("GH_FAKE_LOG", f.log)
	t.Setenv("GH_FAKE_SLEEP", "")
	t.Cleanup(f.assertRealShape)
	return f
}

func (f *fakeGitHub) calls() []string {
	data, err := os.ReadFile(f.log)
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

func (f *fakeGitHub) assertRealShape() {
	f.t.Helper()
	for _, call := range f.calls() {
		if call != "" && !realGHCall.MatchString(call) {
			f.t.Errorf("gh was called as %q, not the one read-only shape", call)
		}
	}
}

// githubProjectDir is a git repo named 3ngram whose origin is the real
// repository, so bare references resolve against B3dmar/3ngram.
func githubProjectDir(t *testing.T) string {
	t.Helper()
	dir := projectDir(t, "3ngram")
	gitInit(t, dir)
	if out, err := exec.Command("git", "-C", dir, "remote", "add", "origin", "git@github.com:B3dmar/3ngram.git").CombinedOutput(); err != nil {
		t.Fatalf("git remote add: %v %s", err, out)
	}
	return dir
}

func TestExtractGitHubRefs(t *testing.T) {
	repo := &githubRepo{Owner: "B3dmar", Name: "3ngram"}
	cases := []struct {
		name      string
		text      string
		bare      *githubRepo
		want      []string
		ambiguous int
	}{
		{"url", "see https://github.com/B3dmar/3ngram-platform/pull/708 now", nil, []string{"B3dmar/3ngram-platform#708"}, 0},
		{"qualified", "after B3dmar/3ngram#251 lands", nil, []string{"B3dmar/3ngram#251"}, 0},
		{"bare with repo", "PR #251 and (#255), #233.", repo, []string{"B3dmar/3ngram#251", "B3dmar/3ngram#255", "B3dmar/3ngram#233"}, 0},
		{"bare without repo", "PR #251", nil, nil, 1},
		{"repo-like token before bare", "fixes (3ngram-platform #718) and #214", repo, []string{"B3dmar/3ngram#214"}, 1},
		{"plain word before bare", "Run the #166 scoring pass", repo, []string{"B3dmar/3ngram#166"}, 0},
		{"html entity and heading", "&#123; # Heading", repo, nil, 0},
		{"dedupe across forms", "B3dmar/3ngram#251, https://github.com/B3dmar/3ngram/pull/251 and PR #251", repo, []string{"B3dmar/3ngram#251"}, 0},
		{"zero is no reference", "#0", repo, nil, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scan := extractGitHubRefs(tc.text, tc.bare)
			var got []string
			for _, ref := range scan.refs {
				got = append(got, ref.String())
			}
			if strings.Join(got, ",") != strings.Join(tc.want, ",") || scan.ambiguous != tc.ambiguous {
				t.Fatalf("refs=%v ambiguous=%d, want %v %d", got, scan.ambiguous, tc.want, tc.ambiguous)
			}
		})
	}
}

func TestGitHubRemote(t *testing.T) {
	for remote, want := range map[string]string{
		"git@github.com:B3dmar/3ngram.git":        "B3dmar/3ngram",
		"https://github.com/B3dmar/3ngram":        "B3dmar/3ngram",
		"ssh://git@github.com/B3dmar/3ngram.git":  "B3dmar/3ngram",
		"https://gitlab.com/B3dmar/3ngram.git":    "",
		"https://github.com/B3dmar/3ngram/tree/x": "",
		"": "",
	} {
		got := ""
		if r := githubRemote(remote); r != nil {
			got = r.Owner + "/" + r.Name
		}
		if got != want {
			t.Errorf("githubRemote(%q) = %q, want %q", remote, got, want)
		}
	}
}

func TestBareRepoNeedsAVerifiedProjectRow(t *testing.T) {
	remote := &githubRepo{Owner: "B3dmar", Name: "3ngram"}
	sel := briefingSelector{Kind: "project", Project: "3ngram"}
	if bareRepoFor(remote, filingProject, sel) == nil {
		t.Fatal("a verified project row of the remote's project resolves bare references")
	}
	for name, got := range map[string]*githubRepo{
		"unscoped row":  bareRepoFor(remote, filingUnscoped, sel),
		"unknown row":   bareRepoFor(remote, filingUnknown, sel),
		"other project": bareRepoFor(remote, filingProject, briefingSelector{Kind: "project", Project: "other"}),
		"no remote":     bareRepoFor(nil, filingProject, sel),
	} {
		if got != nil {
			t.Errorf("%s must not resolve bare references", name)
		}
	}
}

func githubListServer(t *testing.T, items ...fixtureItem) {
	t.Helper()
	s := newReadServer(t)
	s.json("/api/v1/me", 200, meBody)
	s.json("/api/v1/briefing", 200, briefingBody(projectSel("3ngram"), section(len(items), items...), section(0)))
}

func TestCommitmentsListGitHubEvidence(t *testing.T) {
	gh := installFakeGH(t)
	merged, open, missing := item(1, "Ship the scan fix (PR #251)"), item(2, "Panel tracked in #255"), item(3, "Old ref #999999")
	githubListServer(t, merged, open, missing)

	r := runCommitmentsForTest(t, githubProjectDir(t), "list", "--github")

	rows := rowsOf(r.env)
	if !r.env.OK || len(rows) != 3 {
		t.Fatalf("env = %s", r.stdout)
	}
	if g := rows[0].GitHub; len(g) != 1 || g[0].Type != "pull_request" || g[0].State != "merged" || g[0].MergedAt == nil || g[0].Ref != "B3dmar/3ngram#251" {
		t.Fatalf("merged PR evidence = %+v", g)
	}
	if g := rows[1].GitHub; len(g) != 1 || g[0].Type != "issue" || g[0].State != "open" {
		t.Fatalf("open issue evidence = %+v", g)
	}
	if g := rows[2].GitHub; len(g) != 1 || g[0].State != githubStateNotFound {
		t.Fatalf("missing reference evidence = %+v", g)
	}
	if w := r.env.GitHubSearch; w == nil || w.Found != 3 || w.Checked != 3 || w.Cap != maxGitHubRefs {
		t.Fatalf("window = %+v", r.env.GitHubSearch)
	}
	if len(gh.calls()) != 3 {
		t.Fatalf("calls = %v", gh.calls())
	}
}

func TestCommitmentsListWithoutGitHubRunsNoProcess(t *testing.T) {
	gh := installFakeGH(t)
	githubListServer(t, item(1, "PR #251"))

	r := runCommitmentsForTest(t, githubProjectDir(t), "list")

	if !r.env.OK || r.env.GitHubSearch != nil || rowsOf(r.env)[0].GitHub != nil || len(gh.calls()) != 0 {
		t.Fatalf("gh must not run without --github: calls=%v env=%s", gh.calls(), r.stdout)
	}
}

func TestCommitmentsListBareRefsNeedAGitHubRemote(t *testing.T) {
	gh := installFakeGH(t)
	githubListServer(t, item(1, "PR #251"))

	r := runCommitmentsForTest(t, projectDir(t, "3ngram"), "list", "--github")

	if w := r.env.GitHubSearch; w == nil || w.Found != 0 || w.Ambiguous != 1 || len(gh.calls()) != 0 {
		t.Fatalf("without a GitHub remote a bare ref is skipped: window=%+v calls=%v", r.env.GitHubSearch, gh.calls())
	}
}

func TestCommitmentsListGitHubFailures(t *testing.T) {
	t.Run("gh missing", func(t *testing.T) {
		// A qualified reference needs no remote, so nothing but gh is missing.
		githubListServer(t, item(1, "after B3dmar/3ngram#251"))
		dir := projectDir(t, "3ngram")
		t.Setenv("PATH", t.TempDir())

		r := runCommitmentsForTest(t, dir, "list", "--github")

		if !r.env.OK || !hasPartial(r.env, "github", "gh_missing") || rowsOf(r.env)[0].GitHub != nil {
			t.Fatalf("env = %s", r.stdout)
		}
	})
	t.Run("not signed in stops the batch", func(t *testing.T) {
		gh := installFakeGH(t)
		if err := os.WriteFile(filepath.Join(gh.dir, "unauthenticated"), nil, 0o644); err != nil {
			t.Fatal(err)
		}
		githubListServer(t, item(1, "#251"), item(2, "#255"), item(3, "#233"), item(4, "#244"), item(5, "#1"), item(6, "#2"))

		r := runCommitmentsForTest(t, githubProjectDir(t), "list", "--github")

		if !r.env.OK || !hasPartial(r.env, "github", "gh_unauthenticated") || r.env.GitHubSearch.Checked != 0 {
			t.Fatalf("env = %s", r.stdout)
		}
		if n := len(gh.calls()); n > readConcurrency {
			t.Fatalf("a sign-in failure must stop the batch, ran %d", n)
		}
	})
	t.Run("deadline", func(t *testing.T) {
		withDeadline(t, 400*time.Millisecond)
		installFakeGH(t)
		t.Setenv("GH_FAKE_SLEEP", "5")
		githubListServer(t, item(1, "PR #251"))

		start := time.Now()
		r := runCommitmentsForTest(t, githubProjectDir(t), "list", "--github")

		if time.Since(start) > 3*time.Second {
			t.Fatalf("GitHub lookups outlived the deadline")
		}
		if !r.env.OK || !hasPartial(r.env, "github", kindTimeout) {
			t.Fatalf("env = %s", r.stdout)
		}
	})
	t.Run("cap", func(t *testing.T) {
		gh := installFakeGH(t)
		var items []fixtureItem
		for i := 1; i <= 12; i++ {
			items = append(items, item(i, "#"+strings.Repeat("1", i)))
		}
		githubListServer(t, items...)

		r := runCommitmentsForTest(t, githubProjectDir(t), "list", "--github")

		if len(gh.calls()) != maxGitHubRefs || !strings.Contains(r.stdout, `"part":"github","reason":"lookup_cap","returned":10,"total":12`) {
			t.Fatalf("calls=%d env=%s", len(gh.calls()), r.stdout)
		}
	})
}

func TestCommitmentsShowGitHubVerdict(t *testing.T) {
	cases := map[string]struct {
		content string
		verdict string
	}{
		"merged PR is evidence to review": {"Done once PR #251 is merged.", verdictReview},
		"closed issue is evidence":        {"Tracked in #233.", verdictReview},
		"open references change nothing":  {"See #255 and #244.", verdictNoneFound},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			installFakeGH(t)
			s := showServer(t, emptyHistory(), []any{})
			memory := strings.Replace(commitmentMemory("work", strPtr("3ngram")), "Full commitment text", tc.content, 1)
			s.json("/api/v1/memories/"+commitmentID, 200, memory)

			r := runCommitmentsForTest(t, githubProjectDir(t), "show", commitmentID, "--github")

			if !r.env.OK || r.env.Evidence.Verdict != tc.verdict || len(r.env.Evidence.GitHub) == 0 || r.env.Evidence.Inspected.GitHub == nil {
				t.Fatalf("env = %s", r.stdout)
			}
		})
	}
}

func emptyHistory() string {
	return mustJSON(map[string]any{
		"memory":              historyNode(commitmentID, "the commitment", "work", strPtr("3ngram"), true),
		"lineage":             map[string]any{"nodes": []any{}, "edges": []any{}, "truncated": false},
		"directRelationships": map[string]any{"predecessors": []any{}, "successors": []any{}, "truncated": false},
		"auditEvents":         []any{},
		"eventsTruncated":     false,
		"sections":            map[string]any{"lineage": "ok", "events": "ok"},
	})
}
