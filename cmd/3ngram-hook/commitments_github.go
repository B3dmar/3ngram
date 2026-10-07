// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// GitHub references in a commitment are RELATED evidence, never proof: a
// merged PR or a closed issue a commitment mentions may be why it is done, or
// one step of it. Each reference is read with exactly one command,
//
//	gh api --method GET repos/{owner}/{repo}/issues/{number}
//
// which answers for issues and pull requests alike (a pull request carries a
// `pull_request` object), so a reference's type never has to be guessed. This
// is the only file of the data path allowed to run a process, and
// readOnlyViolations holds it to that one argument shape.

const (
	maxGitHubRefs       = 10
	githubReference     = "github_reference"
	refFormURL          = "url"
	refFormQualified    = "qualified"
	refFormBare         = "bare"
	githubStateNotFound = "not_found"
)

// githubRepo is an owner/name pair as GitHub spells it in a path.
type githubRepo struct {
	Owner string
	Name  string
}

func (r githubRepo) key() string { return strings.ToLower(r.Owner + "/" + r.Name) }

type githubRef struct {
	Repo   githubRepo
	Number int
	Form   string
}

func (r githubRef) String() string {
	return r.Repo.Owner + "/" + r.Repo.Name + "#" + strconv.Itoa(r.Number)
}

func (r githubRef) key() string { return r.Repo.key() + "#" + strconv.Itoa(r.Number) }

// githubEvidence is one reference as GitHub reported it.
type githubEvidence struct {
	Kind          string  `json:"kind"`
	Source        string  `json:"source"`
	Ref           string  `json:"ref"`
	ReferenceForm string  `json:"referenceForm"`
	Type          string  `json:"type"`
	State         string  `json:"state"`
	StateReason   *string `json:"stateReason"`
	ClosedAt      *string `json:"closedAt"`
	MergedAt      *string `json:"mergedAt"`
	Title         string  `json:"title,omitempty"`
	URL           string  `json:"url,omitempty"`
}

// signalsResolution reports whether a reference could explain a resolution:
// merged, or closed. An open reference is still listed as related context.
func (g githubEvidence) signalsResolution() bool {
	return g.State == "merged" || g.State == "closed"
}

var (
	githubURLRef       = regexp.MustCompile(`https?://github\.com/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)/(?:issues|pull)/(\d+)`)
	githubQualifiedRef = regexp.MustCompile(`(?:^|[^A-Za-z0-9_./-])([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)#(\d+)\b`)
	githubBareRef      = regexp.MustCompile(`(?:^|[^A-Za-z0-9_/#&])#(\d+)\b`)
)

// refScan is what extraction found in one text: the references it can
// resolve, and the bare ones it refused to guess.
type refScan struct {
	refs      []githubRef
	ambiguous int
}

// extractGitHubRefs finds the references in text. URLs and owner/repo#N
// always name their repository. A bare #N names one only when bareRepo is set
// (the caller decides when that is safe) and it does not directly follow a
// token that looks like another repository's name ("3ngram-platform #718"),
// which would otherwise be read as this repository's issue 718.
func extractGitHubRefs(text string, bareRepo *githubRepo) refScan {
	var scan refScan
	seen := map[string]bool{}
	add := func(ref githubRef) {
		if ref.Number <= 0 || seen[ref.key()] {
			return
		}
		seen[ref.key()] = true
		scan.refs = append(scan.refs, ref)
	}
	consumed := make([]bool, len(text))
	for _, m := range githubURLRef.FindAllStringSubmatchIndex(text, -1) {
		n, _ := strconv.Atoi(text[m[6]:m[7]])
		add(githubRef{Repo: githubRepo{Owner: text[m[2]:m[3]], Name: text[m[4]:m[5]]}, Number: n, Form: refFormURL})
		markConsumed(consumed, m[0], m[1])
	}
	for _, m := range githubQualifiedRef.FindAllStringSubmatchIndex(text, -1) {
		if consumed[m[2]] {
			continue
		}
		n, _ := strconv.Atoi(text[m[6]:m[7]])
		add(githubRef{Repo: githubRepo{Owner: text[m[2]:m[3]], Name: text[m[4]:m[5]]}, Number: n, Form: refFormQualified})
		markConsumed(consumed, m[2], m[1])
	}
	for _, m := range githubBareRef.FindAllStringSubmatchIndex(text, -1) {
		hash := m[2] - 1
		if consumed[hash] {
			continue
		}
		if bareRepo == nil || followsRepoLikeToken(text, hash) {
			scan.ambiguous++
			continue
		}
		n, _ := strconv.Atoi(text[m[2]:m[3]])
		add(githubRef{Repo: *bareRepo, Number: n, Form: refFormBare})
	}
	return scan
}

func markConsumed(consumed []bool, from, to int) {
	for i := from; i < to && i < len(consumed); i++ {
		consumed[i] = true
	}
}

// followsRepoLikeToken reports whether the word right before position hash
// (one space between) carries a character repository names have and English
// words do not: "3ngram-platform #718", "repo.js #3", "my_repo #2".
func followsRepoLikeToken(text string, hash int) bool {
	before := strings.TrimRight(text[:hash], " ")
	if len(before) == len(text[:hash]) || before == "" {
		return false
	}
	start := strings.LastIndexAny(before, " \t\n([{\"'") + 1
	return strings.ContainsAny(before[start:], "-._/")
}

// githubRemote parses an origin remote URL into its GitHub repository, or
// returns nil for any remote that is not github.com.
func githubRemote(remote string) *githubRepo {
	remote = strings.TrimSuffix(strings.TrimSpace(remote), ".git")
	for _, prefix := range []string{"git@github.com:", "ssh://git@github.com/", "https://github.com/", "http://github.com/"} {
		if rest, ok := strings.CutPrefix(remote, prefix); ok {
			parts := strings.Split(rest, "/")
			if len(parts) == 2 && parts[0] != "" && parts[1] != "" {
				return &githubRepo{Owner: parts[0], Name: parts[1]}
			}
		}
	}
	return nil
}

// githubOptions is whether an operation looks up GitHub references, and the
// origin remote's repository a bare #N may resolve against.
type githubOptions struct {
	enabled bool
	remote  *githubRepo
}

func githubFor(ctx context.Context, opts commitmentsOptions) githubOptions {
	if !opts.github {
		return githubOptions{}
	}
	return githubOptions{enabled: true, remote: githubRemote(originRemoteURL(ctx, opts.cwd))}
}

// bareRepoFor is the repository a bare #N may resolve against for a row: the
// origin remote's, only when it is on github.com and the row is verified to
// belong to the project that remote names.
func bareRepoFor(remote *githubRepo, filing string, sel briefingSelector) *githubRepo {
	if remote == nil || filing != filingProject || strings.ToLower(remote.Name) != sel.Project {
		return nil
	}
	return remote
}

type ghIssue struct {
	Number      int     `json:"number"`
	Title       string  `json:"title"`
	State       string  `json:"state"`
	StateReason *string `json:"state_reason"`
	ClosedAt    *string `json:"closed_at"`
	HTMLURL     string  `json:"html_url"`
	PullRequest *struct {
		MergedAt *string `json:"merged_at"`
		HTMLURL  string  `json:"html_url"`
	} `json:"pull_request"`
}

// githubLookup reads one reference. A failure that will fail every lookup
// (gh missing, not signed in, rate limited) is returned as an error; a
// reference GitHub does not know is evidence with state not_found.
func githubLookup(ctx context.Context, ref githubRef) (githubEvidence, *readError) {
	path := "repos/" + ref.Repo.Owner + "/" + ref.Repo.Name + "/issues/" + strconv.Itoa(ref.Number)
	cmd := exec.CommandContext(ctx, "gh", "api", "--method", "GET", path)
	cmd.Env = append(cmd.Environ(), "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "GH_PAGER=", "NO_COLOR=1")
	// gh runs in its own process group, and cancelling (the deadline, or the
	// plugin's SIGTERM) kills the whole group, so nothing it started outlives
	// the operation. WaitDelay bounds the wait for pipes a killed child left
	// open.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 500 * time.Millisecond
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	ev := githubEvidence{Kind: githubReference, Source: "github", Ref: ref.String(), ReferenceForm: ref.Form, Type: "unknown"}
	if err != nil {
		if ctx.Err() != nil {
			return ev, classifyReadFailure(ctx, "github", 0, nil)
		}
		if errors.Is(err, exec.ErrNotFound) {
			return ev, &readError{Kind: "gh_missing", Route: "github"}
		}
		switch msg := stderr.String(); {
		case strings.Contains(msg, "HTTP 404"):
			ev.State = githubStateNotFound
			return ev, nil
		case strings.Contains(msg, "HTTP 401") || strings.Contains(msg, "gh auth login"):
			return ev, &readError{Kind: "gh_unauthenticated", Route: "github"}
		case strings.Contains(msg, "HTTP 403") || strings.Contains(msg, "HTTP 429") || strings.Contains(strings.ToLower(msg), "rate limit"):
			return ev, &readError{Kind: kindRateLimited, Route: "github"}
		default:
			return ev, &readError{Kind: kindUnavailable, Route: "github"}
		}
	}
	var issue ghIssue
	if json.Unmarshal(out, &issue) != nil || issue.Number != ref.Number {
		return ev, &readError{Kind: kindBadResponse, Route: "github"}
	}
	ev.Title, ev.URL, ev.StateReason, ev.ClosedAt = issue.Title, issue.HTMLURL, issue.StateReason, issue.ClosedAt
	ev.Type, ev.State = "issue", issue.State
	if issue.PullRequest != nil {
		ev.Type = "pull_request"
		ev.MergedAt = issue.PullRequest.MergedAt
		if issue.PullRequest.MergedAt != nil {
			ev.State = "merged"
		}
	}
	return ev, nil
}

// githubBatch looks up refs (already capped by the caller) under the shared
// deadline, at most readConcurrency at a time. A failure that will fail every
// lookup (gh missing, not signed in, rate limited, the deadline) stops the
// batch and is the reason reported; what was not looked up is counted, never
// guessed.
func githubBatch(ctx context.Context, refs []githubRef) (map[string]githubEvidence, *readError, int) {
	results := make([]githubEvidence, len(refs))
	errs := make([]*readError, len(refs))
	batchCtx, stop := context.WithCancel(ctx)
	defer stop()
	var mu sync.Mutex
	var fatal *readError
	forEachBounded(batchCtx, len(refs), readConcurrency, func(c context.Context, n int) {
		results[n], errs[n] = githubLookup(c, refs[n])
		if err := errs[n]; err != nil && err.Kind != kindBadResponse && err.Kind != kindCancelled {
			mu.Lock()
			if fatal == nil {
				fatal = err
			}
			mu.Unlock()
			stop()
		}
	})
	found := map[string]githubEvidence{}
	complete := true
	for n, ref := range refs {
		// githubLookup always stamps Kind, so an empty one was never started.
		if errs[n] == nil && results[n].Kind != "" {
			found[ref.key()] = results[n]
		} else {
			complete = false
		}
	}
	switch {
	case complete:
		return found, nil, len(found)
	case fatal != nil:
		return found, fatal, len(found)
	case ctx.Err() != nil:
		return found, classifyReadFailure(ctx, "github", 0, nil), len(found)
	default:
		return found, &readError{Kind: kindBadResponse, Route: "github"}, len(found)
	}
}

// githubWindow is how far the GitHub search looked.
type githubWindow struct {
	Found     int `json:"found"`
	Checked   int `json:"checked"`
	Cap       int `json:"cap"`
	Ambiguous int `json:"ambiguousSkipped"`
}

// capRefs keeps the first maxGitHubRefs distinct references across texts, in
// order, and reports how many were found in all.
func capRefs(scans []refScan) ([]githubRef, githubWindow) {
	var refs []githubRef
	seen := map[string]bool{}
	window := githubWindow{Cap: maxGitHubRefs}
	for _, scan := range scans {
		window.Ambiguous += scan.ambiguous
		for _, ref := range scan.refs {
			if seen[ref.key()] {
				continue
			}
			seen[ref.key()] = true
			window.Found++
			if len(refs) < maxGitHubRefs {
				refs = append(refs, ref)
			}
		}
	}
	return refs, window
}

// githubParts labels what the GitHub search could not finish.
func githubParts(window githubWindow, failure *readError) []partialPart {
	if failure == nil && window.Checked == window.Found {
		return nil
	}
	reason := "lookup_cap"
	if failure != nil {
		reason = failure.Kind
	}
	return []partialPart{countedPart("github", reason, window.Checked, window.Found)}
}

// sortedEvidence returns the evidence for refs in the order they were found.
func sortedEvidence(refs []githubRef, found map[string]githubEvidence) []githubEvidence {
	out := []githubEvidence{}
	for _, ref := range refs {
		if ev, ok := found[ref.key()]; ok {
			out = append(out, ev)
		}
	}
	return out
}
