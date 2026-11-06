// SPDX-License-Identifier: Apache-2.0
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBriefingAllowsVerifiedWritesWithoutHookCredential(t *testing.T) {
	for _, state := range []string{"missing", "blank", "unreadable"} {
		for _, source := range []string{"startup", "resume", "compact"} {
			t.Run(state+"/"+source, func(t *testing.T) {
				ls := newLifecycleServer(t, briefingWith(nil))
				unavailableCredential(t, state)
				out := captureHook(t, fmt.Sprintf(`{"session_id":"fixture-session","source":%q}`, source), func() int {
					return runBriefing(nil)
				})
				assertOptionalAttributionInstruction(t, out)
				if strings.Contains(out, "**3ngram session run**") || strings.Contains(out, testRunID) {
					t.Fatal("unavailable credential exposed a run ID")
				}
				if len(ls.paths()) != 0 {
					t.Fatal("unavailable credential must make no network requests")
				}
			})
		}
	}
}

func TestBriefingWithoutCredentialKeepsNonSessionsSilent(t *testing.T) {
	for _, tc := range []struct{ name, payload, role string }{
		{"manual", "", ""}, {"no session", `{}`, ""},
		{"blank session", `{"session_id":"  "}`, ""},
		{"suppressed", `{"session_id":"fixture-session","source":"resume"}`, "subagent"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ls := newLifecycleServer(t, briefingWith(nil))
			unavailableCredential(t, "missing")
			t.Setenv("THREENGRAM_HOOK_ROLE", tc.role)
			out := captureHook(t, tc.payload, func() int { return runBriefing(nil) })
			if out != "" || len(ls.paths()) != 0 {
				t.Fatal("manual, absent and suppressed sessions must stay silent without requests")
			}
		})
	}
}

func unavailableCredential(t *testing.T, state string) {
	t.Helper()
	isolateKeyFiles(t)
	t.Setenv("THREENGRAM_API_KEY", "")
	for _, path := range apiKeyFilePaths() {
		if state == "missing" {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		var err error
		if state == "unreadable" {
			// A directory guarantees ReadFile fails even when tests run as root.
			err = os.Mkdir(path, 0700)
		} else {
			err = os.WriteFile(path, []byte(" \n\t"), 0600)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
}
