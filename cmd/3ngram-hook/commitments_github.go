// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
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
// a merged pull request, or a closed issue. An open reference, and a pull
// request closed without being merged (abandoned or rejected), are still
// listed as related context and change nothing.
func (g githubEvidence) signalsResolution() bool {
	return g.State == "merged" || (g.Type == "issue" && g.State == "closed")
}

var (
	githubURLRef       = regexp.MustCompile(`(?i:https?://github\.com)/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)/(?:issues|pull)/(\d{1,9})\b`)
	githubQualifiedRef = regexp.MustCompile(`(?:^|[^A-Za-z0-9_./-])([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)#(\d{1,9})\b`)
	githubBareRef      = regexp.MustCompile(`(?:^|[^A-Za-z0-9_/#&])#(\d{1,9})\b`)
	githubSegment      = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
)

// validRepo keeps a repository whose owner and name are plain path segments:
// never a dot segment, never a character that could change the API path.
func validRepo(r githubRepo) bool {
	for _, seg := range []string{r.Owner, r.Name} {
		if seg == "." || seg == ".." || !githubSegment.MatchString(seg) {
			return false
		}
	}
	return true
}

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
	type found struct {
		at  int
		ref githubRef
	}
	var scan refScan
	var hits []found
	consumed := make([]bool, len(text))
	for _, m := range githubURLRef.FindAllStringSubmatchIndex(text, -1) {
		n, _ := strconv.Atoi(text[m[6]:m[7]])
		hits = append(hits, found{m[0], githubRef{Repo: githubRepo{Owner: text[m[2]:m[3]], Name: text[m[4]:m[5]]}, Number: n, Form: refFormURL}})
		markConsumed(consumed, m[0], m[1])
	}
	for _, m := range githubQualifiedRef.FindAllStringSubmatchIndex(text, -1) {
		if consumed[m[2]] {
			continue
		}
		n, _ := strconv.Atoi(text[m[6]:m[7]])
		hits = append(hits, found{m[2], githubRef{Repo: githubRepo{Owner: text[m[2]:m[3]], Name: text[m[4]:m[5]]}, Number: n, Form: refFormQualified}})
		markConsumed(consumed, m[2], m[1])
	}
	for _, m := range githubBareRef.FindAllStringSubmatchIndex(text, -1) {
		hash := m[2] - 1
		if consumed[hash] || labelsGitHubLink(text[m[1]:]) {
			continue
		}
		if bareRepo == nil || followsRepoLikeToken(text, hash) {
			scan.ambiguous++
			continue
		}
		n, _ := strconv.Atoi(text[m[2]:m[3]])
		hits = append(hits, found{hash, githubRef{Repo: *bareRepo, Number: n, Form: refFormBare}})
	}
	// In the order the text names them, whatever their form, so the cap keeps
	// the first references a reader sees.
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].at < hits[j].at })
	seen := map[string]bool{}
	for _, h := range hits {
		if h.ref.Number <= 0 || !validRepo(h.ref.Repo) || seen[h.ref.key()] {
			continue
		}
		seen[h.ref.key()] = true
		scan.refs = append(scan.refs, h.ref)
	}
	return scan
}

// labelsGitHubLink reports whether the text right after a bare #N makes it
// the label of a markdown link to a GitHub issue or pull request
// ("[#718](https://github.com/org/other/issues/718)"). The destination names
// the reference, and the URL pass reads it; the label must not also be read
// as this repository's #718.
func labelsGitHubLink(after string) bool {
	dest, ok := strings.CutPrefix(after, "](")
	if !ok {
		return false
	}
	loc := githubURLRef.FindStringIndex(dest)
	return loc != nil && loc[0] == 0
}

func markConsumed(consumed []bool, from, to int) {
	for i := from; i < to && i < len(consumed); i++ {
		consumed[i] = true
	}
}

// followsRepoLikeToken reports whether the word right before position hash
// carries a separator INSIDE it the way a repository name does:
// "3ngram-platform #718", "repo.js #3", "my_repo #2". The gap between that
// word and the reference may hold whitespace, a colon, opening punctuation
// and markdown emphasis or code marks, so "3ngram-platform (#718)",
// "3ngram-platform:#718" and "3ngram-platform `#718`" count too. Sentence punctuation around the word does not ("Done. #251",
// "(see #4)"), and a reference attached directly to the word ("PR-#12") is
// read as this repository's. The rule fails safe: a hyphenated English word
// such as "follow-up #12" is skipped too and counted as ambiguous, since
// resolving it against the wrong repository would be worse than not
// resolving it; owner/repo#N is always unambiguous.
func followsRepoLikeToken(text string, hash int) bool {
	before := strings.TrimRightFunc(text[:hash], func(r rune) bool {
		return unicode.IsSpace(r) || strings.ContainsRune(refGapPunct, r)
	})
	if len(before) == hash || before == "" {
		return false
	}
	start := 0
	if i := strings.LastIndexFunc(before, func(r rune) bool { return unicode.IsSpace(r) || strings.ContainsRune(refWordOpen, r) }); i >= 0 {
		// Past the delimiter, whatever its width (a no-break space is two bytes).
		_, width := utf8.DecodeRuneInString(before[i:])
		start = i + width
	}
	word := strings.TrimRight(before[start:], ".,;:!?)]}>\"'`*_~")
	for i := 1; i < len(word)-1; i++ {
		if strings.ContainsRune("-._/", rune(word[i])) && isAlnum(word[i-1]) && isAlnum(word[i+1]) {
			return true
		}
	}
	return false
}

// refGapPunct is the punctuation that may sit between a repository-like word
// and the reference it qualifies: a label colon, what opens an aside or a
// quote, and markdown's emphasis and code marks.
const refGapPunct = ":([{<\"'`*_~"

// refWordOpen is what may open the word itself. It leaves out the underscore
// and the colon, which can sit inside a repository-like word ("my_repo").
const refWordOpen = "([{<\"'`*~"

func isAlnum(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// githubRemote parses an origin remote URL into its GitHub repository, or
// returns nil for any remote that is not github.com.
func githubRemote(remote string) *githubRepo {
	remote = strings.TrimSpace(remote)
	var host, path string
	if u, err := url.Parse(remote); err == nil && u.Scheme != "" && u.Host != "" {
		// https://[user@]github.com[:port]/owner/repo, ssh://git@github.com[:port]/owner/repo
		host, path = u.Hostname(), u.Path
	} else if colon := strings.Index(remote, ":"); colon > 0 && !strings.Contains(remote, "://") && !strings.Contains(remote[:colon], "/") {
		// The SCP-like form git uses for ssh: [user@]github.com:owner/repo,
		// the user optional (ssh config may supply it).
		host, path = remote[:colon], remote[colon+1:]
		if at := strings.LastIndex(host, "@"); at >= 0 {
			host = host[at+1:]
		}
	} else {
		return nil
	}
	if !strings.EqualFold(host, "github.com") {
		return nil
	}
	path = strings.TrimSuffix(strings.Trim(path, "/"), ".git")
	parts := strings.Split(path, "/")
	if len(parts) != 2 {
		return nil
	}
	repo := githubRepo{Owner: parts[0], Name: parts[1]}
	if !validRepo(repo) {
		return nil
	}
	return &repo
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

// Kinds a gh failure can have. The batch-fatal ones fail every later lookup
// too, so they stop the batch; the others concern one reference only.
const (
	kindGHMissing         = "gh_missing"
	kindGHUnauthenticated = "gh_unauthenticated"
	kindGHForbidden       = "forbidden"
)

func batchFatal(kind string) bool {
	switch kind {
	case kindGHMissing, kindGHUnauthenticated, kindRateLimited, kindTimeout:
		return true
	}
	return false
}

// maxGitHubTitle bounds an issue or PR title. Titles are third-party text,
// shown as such and never as instructions, and a long one says no more.
const maxGitHubTitle = 200

func truncateRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// ghEnvironment pins gh to github.com (an enterprise GH_HOST or default
// host would otherwise send a github.com reference to another server), drops
// a GH_REPO that could redirect it, and disables prompts, pagers and update
// checks.
func ghEnvironment(base []string) []string {
	env := make([]string, 0, len(base)+5)
	for _, kv := range base {
		if strings.HasPrefix(kv, "GH_HOST=") || strings.HasPrefix(kv, "GH_REPO=") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, "GH_HOST=github.com", "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "GH_PAGER=", "NO_COLOR=1")
}

// classifyGHFailure maps a failed `gh api` to a kind from its stderr, which
// is only ever matched here, never emitted. A reference GitHub does not know,
// or no longer has, is evidence with state not_found rather than a failure.
func classifyGHFailure(msg string, ev *githubEvidence) *readError {
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(msg, "HTTP 404") || strings.Contains(msg, "HTTP 410"):
		ev.State = githubStateNotFound
		return nil
	case strings.Contains(msg, "HTTP 401") || strings.Contains(msg, "gh auth login"):
		return &readError{Kind: kindGHUnauthenticated, Route: "github"}
	case strings.Contains(msg, "HTTP 429") || strings.Contains(lower, "rate limit") || strings.Contains(lower, "abuse"):
		return &readError{Kind: kindRateLimited, Route: "github"}
	case strings.Contains(msg, "HTTP 403"):
		return &readError{Kind: kindGHForbidden, Route: "github"}
	default:
		return &readError{Kind: kindUnavailable, Route: "github"}
	}
}

// githubLookup reads one reference. A failure that will fail every lookup
// (gh missing, not signed in, rate limited) is returned as an error; a
// reference GitHub does not know is evidence with state not_found.
func githubLookup(ctx context.Context, ref githubRef) (githubEvidence, *readError) {
	path := "repos/" + ref.Repo.Owner + "/" + ref.Repo.Name + "/issues/" + strconv.Itoa(ref.Number)
	cmd := exec.CommandContext(ctx, "gh", "api", "--method", "GET", path)
	cmd.Env = ghEnvironment(cmd.Environ())
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
			return ev, &readError{Kind: kindGHMissing, Route: "github"}
		}
		return ev, classifyGHFailure(stderr.String(), &ev)
	}
	var issue ghIssue
	if json.Unmarshal(out, &issue) != nil || issue.Number != ref.Number {
		return ev, &readError{Kind: kindBadResponse, Route: "github"}
	}
	ev.Title, ev.URL, ev.StateReason, ev.ClosedAt = truncateRunes(issue.Title, maxGitHubTitle), issue.HTMLURL, issue.StateReason, issue.ClosedAt
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
		if err := errs[n]; err != nil && batchFatal(err.Kind) {
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
	}
	// Only per-reference failures: report the first, in reference order.
	for _, err := range errs {
		if err != nil {
			return found, err, len(found)
		}
	}
	return found, &readError{Kind: kindBadResponse, Route: "github"}, len(found)
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
// A reference looked up once may be named by several rows in different forms;
// each row's evidence carries the form that row used.
func sortedEvidence(refs []githubRef, found map[string]githubEvidence) []githubEvidence {
	out := []githubEvidence{}
	for _, ref := range refs {
		if ev, ok := found[ref.key()]; ok {
			ev.ReferenceForm = ref.Form
			out = append(out, ev)
		}
	}
	return out
}
