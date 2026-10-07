// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
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

	out, err := exec.CommandContext(ctx, "git", "-C", cwd, "remote", "get-url", "origin").Output()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return "", projectSourceNone, ctxErr
	}
	if err == nil {
		remote := strings.TrimSpace(string(out))
		remote = strings.TrimSuffix(remote, ".git")
		parts := strings.FieldsFunc(remote, func(r rune) bool {
			return r == '/' || r == ':'
		})
		if len(parts) > 0 {
			return strings.ToLower(parts[len(parts)-1]), projectSourceGitRemote, nil
		}
	}

	return strings.ToLower(filepath.Base(cwd)), projectSourceDirectory, nil
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
