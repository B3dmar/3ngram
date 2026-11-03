// SPDX-License-Identifier: Apache-2.0
package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSessionInstructionRequiresMatchingAccount(t *testing.T) {
	for _, source := range []string{"startup", "resume", "compact", "clear"} {
		t.Run(source, func(t *testing.T) {
			ls := newLifecycleServer(t, briefingWith(nil))
			out := captureHook(t, fmt.Sprintf(`{"session_id":"fixture-session","source":%q}`, source), func() int {
				return runBriefing(nil)
			})
			for _, required := range []string{
				"**3ngram session run**: `" + testRunID + "`\n",
				"**3ngram account**: `" + testAccountID + "`",
				"`describe_environment.account.id` matches `" + testAccountID + "`",
				"Never pass this ID to a different or unverified account",
				"defer these writes and report the account boundary",
				"Do not switch accounts to match this ID or reuse a prior run ID",
			} {
				if !strings.Contains(out, required) {
					t.Errorf("instruction missing %q", required)
				}
			}
			captureHook(t, `{"session_id":"fixture-session"}`, func() int { return runStop(nil) })
			captureHook(t, `{"session_id":"fixture-session"}`, func() int { return runClose(nil) })
			for _, req := range ls.requests {
				if req.key != "3ng_test" {
					t.Error("lifecycle changed credential")
				}
			}
		})
	}
}

func TestSessionInstructionDefersWritesWithoutIdentity(t *testing.T) {
	for _, tc := range []struct {
		name string
		code int
		body string
	}{
		{"unauthorized", 401, `{}`}, {"unavailable", 503, `{}`},
		{"malformed", 200, `{`}, {"missing", 200, `{}`},
		{"blank", 200, `{"id":"  "}`}, {"wrong type", 200, `{"id":1}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ls := newLifecycleServer(t, briefingWith(nil))
			ls.accountCode, ls.accountBody = tc.code, tc.body
			out := captureHook(t, `{"session_id":"fixture-session","source":"startup"}`, func() int {
				return runBriefing(nil)
			})
			if strings.Contains(out, testRunID) || strings.Contains(out, "**3ngram session run**") {
				t.Fatal("unverified account exposed a reusable run ID")
			}
			if !strings.Contains(out, "Defer `remember` / `revise` / `resolve`") {
				t.Fatal("identity failure did not defer writes")
			}
			ls.bodyFor(t, "/api/v1/agent-sessions/open") // Lifecycle still opens.
		})
	}
}

func TestSessionInstructionDefersWritesWithoutRun(t *testing.T) {
	out := sessionRunInstruction("", testAccountID)
	if strings.Contains(out, "**3ngram session run**") || !strings.Contains(out, "Defer `remember`") {
		t.Fatal("unavailable run must defer writes without publishing a run marker")
	}
}

func TestSessionAccountLookupHasDeadline(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()
	start := time.Now()
	if got := sessionAccountID(readConfig{base: srv.URL, key: "3ng_test"}, "fixture-session"); got != "" {
		t.Fatal("timed-out identity must be unavailable")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("identity read exceeded deadline: %s", elapsed)
	}
}

func TestBriefingPinsCredentialAcrossAccountAndLifecycle(t *testing.T) {
	ls := newLifecycleServer(t, briefingWith(nil))
	isolateKeyFiles(t)
	t.Setenv("THREENGRAM_API_KEY", "")
	path := filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "3ngram", "api-key")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("3ng_test"), 0600); err != nil {
		t.Fatal(err)
	}
	// Rotate the file on the first request, whichever concurrent GET arrives
	// first. Every request for this invocation must still use the original key.
	handler := ls.Config.Handler
	var once sync.Once
	ls.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		once.Do(func() {
			if err := os.WriteFile(path, []byte("3ng_other_account"), 0600); err != nil {
				t.Error(err)
			}
		})
		handler.ServeHTTP(w, r)
	})
	out := captureHook(t, `{"session_id":"fixture-session","source":"startup"}`, func() int {
		return runBriefing(nil)
	})
	if !strings.Contains(out, testAccountID) {
		t.Fatal("account binding missing")
	}
	for _, req := range ls.requests {
		if req.key != "3ng_test" {
			t.Errorf("%s changed credential mid-invocation", req.path)
		}
	}
	if apiKey() != "3ng_other_account" {
		t.Fatal("fixture did not rotate credential")
	}
}
