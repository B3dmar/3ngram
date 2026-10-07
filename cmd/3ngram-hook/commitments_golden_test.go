// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

// The golden envelopes pin the stdout contract byte for byte, and they are the
// fixtures the Claude Code plugin's own specs parse (plugins/3ngram), so a
// contract change shows up on both sides of the process boundary. Regenerate
// with `go test -run Golden -update`.
var updateGolden = flag.Bool("update", false, "rewrite testdata/commitments golden envelopes")

// Fixed stand-ins for the values that depend on the test server's address.
const (
	goldenFingerprint = "f1f1f1f1f1f1f1f1"
	goldenAPIHost     = "api.example.test"
)

func TestCommitmentsGoldenEnvelopes(t *testing.T) {
	t.Run("list-unscoped", func(t *testing.T) {
		s := newReadServer(t)
		s.json("/api/v1/me", 200, meBody)
		kept, cut, unscoped, failed := item(1, "Kept by the strict read"), item(2, "Cut from the strict slice"), item(3, "Written without a project"), item(4, "Lookup failed")
		kept.dueAt, kept.overdue = "2026-10-01T00:00:00.000Z", true
		unscoped.status = "waiting"
		s.json("/api/v1/briefing?includeUnscoped=true", 200, briefingBody(scopeProjectSel("work", "demo", true),
			section(4, kept, cut, unscoped, failed), section(1, kept)))
		s.json("/api/v1/briefing?includeUnscoped=false", 200, briefingBody(scopeProjectSel("work", "demo", false), section(2, kept), section(1, kept)))
		s.json("/api/v1/memories/"+cut.memoryID, 200, memoryBody("work", strPtr("demo"), "active", nil))
		s.json("/api/v1/memories/"+unscoped.memoryID, 200, memoryBody("work", nil, "active", nil))
		s.json("/api/v1/memories/"+failed.memoryID, 503, `{"error":"unavailable"}`)

		r := runCommitmentsForTest(t, projectDir(t, "demo"), "list", "--scope", "work", "--include-unscoped")
		assertGolden(t, "list-unscoped.json", r.env)
	})
	t.Run("list-auth", func(t *testing.T) {
		s := newReadServer(t)
		s.json("/api/v1/me", 401, `{"error":"unauthorized"}`)
		s.json("/api/v1/briefing", 401, `{"error":"unauthorized"}`)

		r := runCommitmentsForTest(t, projectDir(t, "demo"), "list")
		assertGolden(t, "list-auth.json", r.env)
	})
	t.Run("context", func(t *testing.T) {
		newReadServer(t)

		r := runCommitmentsForTest(t, projectDir(t, "demo"), "context")
		assertGolden(t, "context.json", r.env)
	})
}

func assertGolden(t *testing.T, name string, env commitmentsEnvelope) {
	t.Helper()
	env.Context.Fingerprint = goldenFingerprint
	env.Context.APIHost = goldenAPIHost
	env.Binary = "3ngram-hook test"
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(env); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join("testdata", "commitments", name)
	if *updateGolden {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden %s (run with -update): %v", path, err)
	}
	if !bytes.Equal(want, buf.Bytes()) {
		t.Fatalf("%s drifted from the golden envelope:\n%s", path, buf.String())
	}
}
