// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestApiBaseURL_DefaultsToProduction(t *testing.T) {
	t.Setenv("THREENGRAM_API_BASE", "")
	t.Setenv("THREENGRAM_API_URL", "")
	if got := apiBaseURL(); got != defaultAPIBase {
		t.Fatalf("apiBaseURL() default = %q, want %q", got, defaultAPIBase)
	}
}

func TestApiBaseURL_APIBaseWins(t *testing.T) {
	t.Setenv("THREENGRAM_API_BASE", "https://api.example.com")
	t.Setenv("THREENGRAM_API_URL", "http://legacy.example.com")
	if got := apiBaseURL(); got != "https://api.example.com" {
		t.Fatalf("THREENGRAM_API_BASE should take precedence, got %q", got)
	}
}

func TestApiBaseURL_LegacyAPIURLFallback(t *testing.T) {
	t.Setenv("THREENGRAM_API_BASE", "")
	t.Setenv("THREENGRAM_API_URL", "http://localhost:8000")
	if got := apiBaseURL(); got != "http://localhost:8000" {
		t.Fatalf("THREENGRAM_API_URL fallback failed, got %q", got)
	}
}

func TestApiBaseURL_TrimsWhitespace(t *testing.T) {
	t.Setenv("THREENGRAM_API_BASE", "   ")
	t.Setenv("THREENGRAM_API_URL", "")
	if got := apiBaseURL(); got != defaultAPIBase {
		t.Fatalf("blank THREENGRAM_API_BASE should fall through, got %q", got)
	}
}

func TestApiKey_EnvVarWins(t *testing.T) {
	t.Setenv("THREENGRAM_API_KEY", "3ng_fromenv")
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	if err := os.MkdirAll(filepath.Join(dir, "3ngram"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "3ngram", "api-key"), []byte("3ng_fromfile"), 0600); err != nil {
		t.Fatal(err)
	}

	if got := apiKey(); got != "3ng_fromenv" {
		t.Fatalf("apiKey() = %q, want env-var value", got)
	}
}

func TestApiKey_FallsBackToXDGConfig(t *testing.T) {
	t.Setenv("THREENGRAM_API_KEY", "")
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	if err := os.MkdirAll(filepath.Join(dir, "3ngram"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "3ngram", "api-key"), []byte("3ng_fromfile\n"), 0600); err != nil {
		t.Fatal(err)
	}

	if got := apiKey(); got != "3ng_fromfile" {
		t.Fatalf("apiKey() = %q, want file fallback", got)
	}
}

func TestApiKey_EmptyWhenMissing(t *testing.T) {
	t.Setenv("THREENGRAM_API_KEY", "")
	// Point XDG at an empty dir so the file fallback misses; also clear HOME
	// via a tempdir that has no .config/3ngram file.
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	if got := apiKey(); got != "" {
		t.Fatalf("apiKey() = %q, want empty", got)
	}
}

func TestWarnMissingAPIKey_PrintsOnceAndIsSilenced(t *testing.T) {
	// Isolate the sync.Once and stderr so the test is deterministic.
	warnOnce = sync.Once{}
	var buf bytes.Buffer
	stderrWriter = &buf
	t.Cleanup(func() { stderrWriter = os.Stderr })

	// First call: may print (if no sentinel is fresh).
	warnMissingAPIKey()
	firstLen := buf.Len()

	// Second call: sync.Once has fired, must be a no-op regardless of sentinel state.
	warnMissingAPIKey()
	if buf.Len() != firstLen {
		t.Fatalf("warnMissingAPIKey should be a no-op on 2nd call, buf grew from %d to %d", firstLen, buf.Len())
	}

	// Sanity-check banner content if we printed at all.
	if firstLen > 0 && !strings.Contains(buf.String(), "THREENGRAM_API_KEY not set") {
		t.Fatalf("expected missing-key banner, got: %q", buf.String())
	}
}
