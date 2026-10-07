// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"net/url"
	"os/exec"
	"path/filepath"
	"strings"
)

// Where a derived project name came from, reported in the commitments context so
// the panel header can say whether it read the git remote or fell back to the
// directory name.
const (
	projectSourceGitRemote = "git-remote"
	projectSourceDirectory = "directory-name"
	projectSourceNone      = "none"
)

func deriveProject(cwd string) string {
	name, _ := deriveProjectWithSource(cwd)
	return name
}

// deriveProjectWithSource is deriveProject plus the source of the name. The
// name rule is unchanged: the last segment of the origin remote, lowercased,
// else the directory's basename.
func deriveProjectWithSource(cwd string) (string, string) {
	name, source, _ := deriveProjectWithSourceCtx(context.Background(), cwd)
	return name, source
}

// deriveProjectWithSourceCtx bounds the git call by ctx. When ctx ends while
// git runs, it reports the context error instead of falling back to the
// directory name: a stalled git must not silently pick a different project.
func deriveProjectWithSourceCtx(ctx context.Context, cwd string) (string, string, error) {
	if cwd == "" {
		return "unknown", projectSourceNone, nil
	}

	// The PATH lookup for a bare "git" happens before CommandContext can
	// govern anything, so it runs under ctx too.
	gitPath, err := lookPathCtx(ctx, "git")
	var out []byte
	if err == nil {
		out, err = exec.CommandContext(ctx, gitPath, "-C", cwd, "remote", "get-url", "origin").Output()
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return "", projectSourceNone, ctxErr
	}
	if err == nil {
		if name := projectFromRemote(string(out)); name != "" {
			return name, projectSourceGitRemote, nil
		}
	}

	return strings.ToLower(filepath.Base(cwd)), projectSourceDirectory, nil
}

// projectFromRemote is the repository name in an origin remote, lowercased:
// its last path segment without `.git`. User info, a query and a fragment
// (where a token can ride along) are dropped first, since the name is sent to
// the API and printed in envelopes; the name rule itself is the one the hooks
// have always used, so ordinary remotes name the same project as before.
func projectFromRemote(remote string) string {
	remote = strings.TrimSpace(remote)
	// Only a remote with "://" is a URL: url.Parse also accepts the SCP-like
	// "github.com:org/repo" and reads its host as a scheme.
	if strings.Contains(remote, "://") {
		if u, err := url.Parse(remote); err == nil {
			u.User, u.RawQuery, u.ForceQuery, u.Fragment, u.RawFragment = nil, "", false, "", ""
			remote = u.String()
		} else {
			// A remote git takes but Go does not (an invalid port, a stray
			// %): the user info is dropped by hand, up to the authority's
			// last @, so the name never carries it.
			scheme, rest, _ := strings.Cut(remote, "://")
			authority, path, hasPath := strings.Cut(rest, "/")
			if at := strings.LastIndex(authority, "@"); at >= 0 {
				authority = authority[at+1:]
			}
			remote = scheme + "://" + authority
			if hasPath {
				remote += "/" + path
			}
			if i := strings.IndexAny(remote, "?#"); i >= 0 {
				remote = remote[:i]
			}
		}
	} else if i := strings.IndexAny(remote, "?#"); i >= 0 {
		remote = remote[:i]
	}
	remote = strings.TrimSuffix(remote, ".git")
	parts := strings.FieldsFunc(remote, func(r rune) bool { return r == '/' || r == ':' })
	if len(parts) == 0 {
		return ""
	}
	return strings.ToLower(parts[len(parts)-1])
}

// execLookPath is exec.LookPath, a variable so a test can stall it.
var execLookPath = exec.LookPath

// lookPathCtx is exec.LookPath under ctx: a PATH entry on a stalled or
// automounted filesystem must not hold the lookup past the deadline.
func lookPathCtx(ctx context.Context, name string) (string, error) {
	type result struct {
		path string
		err  error
	}
	done := make(chan result, 1)
	// Read here, not in the goroutine, so a test restoring the variable does
	// not race with a lookup that outlived it.
	lookPath := execLookPath
	go func() {
		path, err := lookPath(name)
		done <- result{path, err}
	}()
	select {
	case r := <-done:
		return r.path, r.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// isSecondaryWorktree reports whether cwd lives in a LINKED (secondary) git
// worktree rather than the main checkout. It compares ROOTS, not raw cwd: cwd is
// rarely the worktree root (Claude may launch from a subdirectory), and the bare
// `cwd != mainPath` check used to mis-flag the main checkout as secondary
// whenever the user ran from any subdir. We resolve cwd's OWN worktree root via
// `git rev-parse --show-toplevel` and compare it against the main worktree root
// (the first entry of `git worktree list --porcelain`). Paths are symlink- and
// trailing-slash-normalized so a prefix-but-different root can't be confused with
// the main checkout. Any git failure falls back to false (never block the hook).
func isSecondaryWorktree(cwd string) bool {
	if cwd == "" {
		return false
	}

	currentRoot := gitWorktreeRoot(cwd)
	if currentRoot == "" {
		return false
	}

	out, err := exec.Command("git", "-C", cwd, "worktree", "list", "--porcelain").Output()
	if err != nil {
		return false
	}
	// The first "worktree" line is the MAIN worktree's root.
	for _, line := range strings.Split(string(out), "\n") {
		if mainRoot, ok := strings.CutPrefix(line, "worktree "); ok {
			return normalizePath(currentRoot) != normalizePath(strings.TrimSpace(mainRoot))
		}
	}
	return false
}

// gitWorktreeRoot resolves the working-tree root that contains cwd (the linked
// worktree root when inside one), or "" if cwd is not in a git working tree.
func gitWorktreeRoot(cwd string) string {
	out, err := exec.Command("git", "-C", cwd, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// normalizePath resolves symlinks and strips a trailing separator so two paths
// that name the same directory compare equal. It falls back to the cleaned input
// when the path can't be resolved (e.g. it no longer exists).
func normalizePath(p string) string {
	if p == "" {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		p = resolved
	}
	return filepath.Clean(p)
}
