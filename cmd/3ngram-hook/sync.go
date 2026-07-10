// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type syncFile struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

type pushPayload struct {
	Files   []syncFile `json:"files"`
	Project string     `json:"project"`
}

type pullResponse struct {
	IndexMD string     `json:"index_md"`
	Files   []syncFile `json:"files"`
}

// runSync is a deliberate no-op on the new server. The CLAUDE.md sync feature
// (POST/GET /api/sync/claude-md/*) is Phase-3-deferred and those routes DO NOT
// exist on the current backend (apps/server), so calling them would either 404
// or, worse, silently do nothing. To keep the hook from ever erroring a user's
// session against an absent endpoint, sync prints a clear message and exits 0.
//
// The original push/pull implementation is preserved as runSyncImpl (guarded off
// below) so it can be re-enabled in one line once the sync routes land in the
// server. Do NOT call runSyncImpl until those routes exist.
func runSync() int {
	fmt.Fprintln(os.Stderr, "3ngram-hook: sync is not yet supported on this backend (deferred); skipping")
	return 0
}

func runSyncImpl() int {
	cwd, _ := os.Getwd()

	if isSecondaryWorktree(cwd) {
		return 0
	}

	key := apiKey()
	if key == "" {
		return 0
	}

	gitRoot, err := gitTopLevel(cwd)
	if err != nil || gitRoot == "" {
		return 0
	}

	project := deriveProject(cwd)

	// Claude Code memory directory uses sanitized git root path
	sanitized := strings.TrimPrefix(strings.ReplaceAll(gitRoot, "/", "-"), "-")
	memoryDir := filepath.Join(os.Getenv("HOME"), ".claude", "projects", sanitized, "memory")

	// Parse mode from args
	mode := "--both"
	if len(os.Args) > 2 {
		mode = os.Args[2]
	}

	switch mode {
	case "--push":
		doPush(memoryDir, project)
	case "--pull":
		doPull(memoryDir, project)
	case "--both":
		doPush(memoryDir, project)
		doPull(memoryDir, project)
	default:
		fmt.Fprintf(os.Stderr, "usage: 3ngram-hook sync [--push|--pull|--both]\n")
		return 1
	}

	return 0
}

func doPush(memoryDir, project string) {
	if _, err := os.Stat(memoryDir); os.IsNotExist(err) {
		return
	}

	var files []syncFile
	filepath.Walk(memoryDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		if filepath.Ext(path) != ".md" {
			return nil
		}

		rel, _ := filepath.Rel(memoryDir, path)
		// Skip 3ngram/ subdir (echo prevention)
		if strings.HasPrefix(rel, "3ngram"+string(filepath.Separator)) || strings.HasPrefix(rel, "3ngram/") {
			return nil
		}

		content, err := os.ReadFile(path)
		if err != nil || len(content) == 0 {
			return nil
		}

		files = append(files, syncFile{Name: rel, Content: string(content)})
		return nil
	})

	if len(files) == 0 {
		return
	}

	payload := pushPayload{Files: files, Project: project}
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}

	apiRequest("POST", "/api/sync/claude-md/push", body, 10*time.Second)
}

func doPull(memoryDir, project string) {
	path := "/api/sync/claude-md/pull?project=" + project
	body, status, err := apiRequest("GET", path, nil, 10*time.Second)
	if err != nil || status >= 400 {
		return
	}

	var resp pullResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return
	}

	if resp.IndexMD == "" {
		return
	}

	outDir := filepath.Join(memoryDir, "3ngram")
	os.MkdirAll(outDir, 0755)

	os.WriteFile(filepath.Join(outDir, "MEMORY.md"), []byte(resp.IndexMD), 0644)

	for _, f := range resp.Files {
		if f.Name == "" || f.Content == "" {
			continue
		}
		// Sanitize filename
		name := filepath.Base(f.Name)
		os.WriteFile(filepath.Join(outDir, name), []byte(f.Content), 0644)
	}
}

func gitTopLevel(cwd string) (string, error) {
	cmd := exec.Command("git", "-C", cwd, "rev-parse", "--show-toplevel")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
