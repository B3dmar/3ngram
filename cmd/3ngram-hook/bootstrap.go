// SPDX-License-Identifier: Apache-2.0
package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// debugDir is where hooks dump raw payloads when THREENGRAM_HOOK_DEBUG=1, and
// where the missing-key warning sentinel lives.
const debugDir = "/tmp/3ngram-hook-debug"

// nowUnix is overridable in tests to control sentinel age.
var nowUnix = func() int64 { return time.Now().Unix() }

// warnOnce limits the missing-API-key warning to one print per process.
// Read-side hooks run on every session/tool event; a warning on each would
// spam stderr.
var warnOnce sync.Once

// warnSentinelName lives next to the debug dump dir. Its mtime is used to
// rate-limit the "missing API key" warning to once every `warnSentinelTTL`
// across processes — otherwise every tool call in a fresh Claude Code session
// would print the banner.
const (
	warnSentinelName = "capture-missing-key.sentinel"
)

// stderrWriter is overridable in tests.
var stderrWriter io.Writer = os.Stderr

func warnMissingAPIKey() {
	warnOnce.Do(func() {
		if !shouldPrintMissingKeyWarning() {
			return
		}
		fmt.Fprintln(stderrWriter, "3ngram: THREENGRAM_API_KEY not set — briefing/precheck hooks are a no-op.")
		fmt.Fprintln(stderrWriter, "  Create a key at https://app.3ngram.ai/settings/api-keys")
		fmt.Fprintln(stderrWriter, "  Then export THREENGRAM_API_KEY=3ng_... (or write it to ~/.config/3ngram/api-key)")
		fmt.Fprintln(stderrWriter, "  Verify with: 3ngram-hook verify")
	})
}

// shouldPrintMissingKeyWarning returns true if we haven't warned recently.
// Uses a sentinel file (mtime check) so the warning surfaces once per session
// rather than once per tool event.
func shouldPrintMissingKeyWarning() bool {
	dir := debugDir
	if err := os.MkdirAll(dir, 0755); err != nil {
		// If we can't create the dir, just print — better noisy than silent.
		return true
	}
	sentinel := filepath.Join(dir, warnSentinelName)
	info, err := os.Stat(sentinel)
	if err == nil {
		// If the sentinel exists and is fresh (< 1h old), skip the warning.
		if info.ModTime().Unix()+3600 > nowUnix() {
			return false
		}
	}
	_ = os.WriteFile(sentinel, []byte("missing api key\n"), 0644)
	return true
}
