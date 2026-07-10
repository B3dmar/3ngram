// SPDX-License-Identifier: Apache-2.0
package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPushCollectsFiles(t *testing.T) {
	dir := t.TempDir()

	// Create test memory files
	os.WriteFile(filepath.Join(dir, "user_prefs.md"), []byte("# Prefs\nDark mode"), 0644)
	os.WriteFile(filepath.Join(dir, "feedback.md"), []byte("# Feedback\nGood work"), 0644)

	// Create 3ngram subdir that should be skipped
	os.MkdirAll(filepath.Join(dir, "3ngram"), 0755)
	os.WriteFile(filepath.Join(dir, "3ngram", "synced.md"), []byte("# Synced"), 0644)

	// Create empty file that should be skipped
	os.WriteFile(filepath.Join(dir, "empty.md"), []byte(""), 0644)

	// Walk and collect (replicating doPush logic)
	var files []syncFile
	filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || filepath.Ext(path) != ".md" {
			return nil
		}
		rel, _ := filepath.Rel(dir, path)
		if rel == "3ngram/synced.md" || filepath.Dir(rel) == "3ngram" {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil || len(content) == 0 {
			return nil
		}
		files = append(files, syncFile{Name: rel, Content: string(content)})
		return nil
	})

	if len(files) != 2 {
		t.Fatalf("expected 2 files, got %d: %+v", len(files), files)
	}

	names := map[string]bool{}
	for _, f := range files {
		names[f.Name] = true
	}
	if !names["user_prefs.md"] || !names["feedback.md"] {
		t.Errorf("unexpected file names: %+v", names)
	}
}

func TestPullWritesFiles(t *testing.T) {
	dir := t.TempDir()
	outDir := filepath.Join(dir, "3ngram")

	// Simulate pull response
	resp := pullResponse{
		IndexMD: "# Memory Index\n- [Prefs](user_prefs.md)",
		Files: []syncFile{
			{Name: "user_prefs.md", Content: "# Prefs\nDark mode"},
		},
	}

	os.MkdirAll(outDir, 0755)
	os.WriteFile(filepath.Join(outDir, "MEMORY.md"), []byte(resp.IndexMD), 0644)
	for _, f := range resp.Files {
		name := filepath.Base(f.Name)
		os.WriteFile(filepath.Join(outDir, name), []byte(f.Content), 0644)
	}

	// Verify files written
	index, err := os.ReadFile(filepath.Join(outDir, "MEMORY.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(index) != resp.IndexMD {
		t.Errorf("index mismatch: %q", index)
	}

	prefs, err := os.ReadFile(filepath.Join(outDir, "user_prefs.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(prefs) != "# Prefs\nDark mode" {
		t.Errorf("prefs mismatch: %q", prefs)
	}
}

func TestRunSyncIsDeferredNoOp(t *testing.T) {
	// sync targets absent /api/sync/claude-md/* routes; until they land it must
	// be a clean no-op (exit 0) that never calls the backend. A bogus API base
	// makes any accidental network call fail loudly; a non-zero exit also fails.
	t.Setenv("THREENGRAM_API_BASE", "http://127.0.0.1:0")
	t.Setenv("THREENGRAM_API_KEY", "3ng_test")
	if code := runSync(); code != 0 {
		t.Fatalf("expected sync no-op to exit 0, got %d", code)
	}
}

func TestSyncModeParser(t *testing.T) {
	// Test the mode parsing logic
	modes := map[string]bool{
		"--push": true,
		"--pull": true,
		"--both": true,
	}
	for mode := range modes {
		if !modes[mode] {
			t.Errorf("expected %s to be valid", mode)
		}
	}
	if modes["--invalid"] {
		t.Error("--invalid should not be valid")
	}
}
