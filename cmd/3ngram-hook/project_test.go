// SPDX-License-Identifier: Apache-2.0
package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// gitInit lays down a minimal committed repo at dir so worktree commands work.
func gitInit(t *testing.T, dir string) {
	t.Helper()
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "user.email", "t@t")
	run("config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(dir, "f"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-q", "-m", "init")
}

func TestIsSecondaryWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	mainRepo := t.TempDir()
	gitInit(t, mainRepo)

	// A subdirectory of the MAIN checkout must NOT be flagged secondary: the
	// regression the root comparison fixes (cwd != mainPath mis-flagged subdirs).
	mainSub := filepath.Join(mainRepo, "pkg", "deep")
	if err := os.MkdirAll(mainSub, 0755); err != nil {
		t.Fatal(err)
	}

	// A linked worktree IS secondary, from its root and from a subdirectory.
	linked := filepath.Join(t.TempDir(), "linked")
	cmd := exec.Command("git", "-C", mainRepo, "worktree", "add", "-q", "-b", "feat-x", linked)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("worktree add: %v\n%s", err, out)
	}
	linkedSub := filepath.Join(linked, "pkg")
	if err := os.MkdirAll(linkedSub, 0755); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		cwd  string
		want bool
	}{
		{"main root", mainRepo, false},
		{"main subdir", mainSub, false},
		{"linked root", linked, true},
		{"linked subdir", linkedSub, true},
		{"non-git dir", t.TempDir(), false},
		{"empty cwd", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isSecondaryWorktree(tc.cwd); got != tc.want {
				t.Errorf("isSecondaryWorktree(%q) = %v, want %v", tc.cwd, got, tc.want)
			}
		})
	}
}
