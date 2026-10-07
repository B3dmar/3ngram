// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

const testAPIKey = "3ng_testprefix_testsecret-do-not-print"

// readServer is a fake 3ngram API that records every request, so each test can
// assert the read-only contract (GET, allow-listed paths) on top of its own
// behaviour.
type readServer struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	requests []readRequest
	routes   map[string]http.HandlerFunc
}

type readRequest struct {
	Method string
	Path   string
	Query  string
	Key    string
}

// allowedReadPath is every path a commitments subcommand may touch. Anything
// else, and any method but GET, fails the test that triggered it.
// A memory id is any one path segment: what an id looks like is the schema's
// business, not the tests'.
var allowedReadPath = regexp.MustCompile(`^/api/v1/(me|briefing|proposals|memories/[^/]+(/history)?)$`)

func newReadServer(t *testing.T) *readServer {
	t.Helper()
	s := &readServer{t: t, routes: map[string]http.HandlerFunc{}}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.requests = append(s.requests, readRequest{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("X-API-Key")})
		s.mu.Unlock()
		key := r.URL.Path
		if r.URL.Path == "/api/v1/briefing" {
			key += "?includeUnscoped=" + r.URL.Query().Get("includeUnscoped")
		}
		if h, ok := s.routes[key]; ok {
			h(w, r)
			return
		}
		if h, ok := s.routes[r.URL.Path]; ok {
			h(w, r)
			return
		}
		http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
	}))
	t.Cleanup(s.srv.Close)
	t.Cleanup(func() { s.assertReadOnly() })
	t.Setenv("THREENGRAM_API_BASE", s.srv.URL)
	t.Setenv("THREENGRAM_API_KEY", testAPIKey)
	isolateKeyFiles(t)
	return s
}

// isolateKeyFiles points the key-file fallbacks at an empty directory, so a
// developer's real ~/.config/3ngram/api-key can never be read by a test.
func isolateKeyFiles(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
}

func (s *readServer) handle(key string, h http.HandlerFunc) { s.routes[key] = h }

func (s *readServer) json(key string, status int, body string) {
	s.handle(key, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})
}

func (s *readServer) recorded() []readRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]readRequest(nil), s.requests...)
}

func (s *readServer) count(path string) int {
	n := 0
	for _, r := range s.recorded() {
		if r.Path == path {
			n++
		}
	}
	return n
}

func (s *readServer) assertReadOnly() {
	s.t.Helper()
	for _, r := range s.recorded() {
		if r.Method != http.MethodGet {
			s.t.Errorf("commitments sent %s %s; only GET is allowed", r.Method, r.Path)
		}
		if !allowedReadPath.MatchString(r.Path) {
			s.t.Errorf("commitments read %s, which is not an allow-listed read path", r.Path)
		}
	}
}

// projectDir is a non-git directory whose basename is the derived project.
func projectDir(t *testing.T, name string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

type runResult struct {
	env    commitmentsEnvelope
	code   int
	stdout string
	stderr string
}

func runCommitmentsForTest(t *testing.T, cwd string, args ...string) runResult {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := commitmentsMain(context.Background(), args, cwd, &stdout, &stderr)
	var env commitmentsEnvelope
	dec := json.NewDecoder(strings.NewReader(stdout.String()))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&env); err != nil {
		t.Fatalf("stdout is not one envelope: %v\n%s", err, stdout.String())
	}
	return runResult{env: env, code: code, stdout: stdout.String(), stderr: stderr.String()}
}

func withDeadline(t *testing.T, d time.Duration) {
	t.Helper()
	orig := commitmentsDeadline
	commitmentsDeadline = d
	t.Cleanup(func() { commitmentsDeadline = orig })
}

// Fixture builders. Ids are fixed uuids so golden files stay stable.
type fixtureItem struct {
	id, memoryID, topic, status, dueAt string
	overdue                            bool
}

func item(n int, topic string) fixtureItem {
	return fixtureItem{
		id:       uuidFor("c", n),
		memoryID: uuidFor("m", n),
		topic:    topic,
		status:   "open",
	}
}

// uuidFor builds a fixed, valid uuid: "c0" prefixes commitment ids and "a0"
// memory ids, so the two can never collide in a fixture.
func uuidFor(prefix string, n int) string {
	hex := map[string]string{"c": "c0", "m": "a0"}[prefix]
	return fmt.Sprintf("00000000-0000-4000-8000-%s%010d", hex, n)
}

func section(count int, items ...fixtureItem) map[string]any {
	list := make([]map[string]any, 0, len(items))
	for _, it := range items {
		var due any
		if it.dueAt != "" {
			due = it.dueAt
		}
		list = append(list, map[string]any{
			"id": it.id, "memoryId": it.memoryID, "topic": it.topic,
			"status": it.status, "dueAt": due, "overdue": it.overdue,
		})
	}
	return map[string]any{"count": count, "items": list, "hasMore": count > len(items)}
}

func briefingBody(selector map[string]any, commitments, overdue map[string]any) string {
	b, _ := json.Marshal(map[string]any{
		"selector":    selector,
		"mode":        "full",
		"generatedAt": "2026-10-07T12:00:00.000Z",
		"commitments": commitments,
		"overdue":     overdue,
	})
	return string(b)
}

// memoryBody answers GET /api/v1/memories/:id. Use memoryBodyFor when the
// handler must answer for a specific id (filing lookups check it).
func memoryBody(scope string, project *string, status string, validTo *string) string {
	return memoryBodyFor("ignored", scope, project, status, validTo)
}

func memoryBodyFor(id, scope string, project *string, status string, validTo *string) string {
	b, _ := json.Marshal(map[string]any{
		"id": id, "memoryType": "commitment", "topic": "ignored", "content": "SECRET CONTENT",
		"scope": scope, "project": project, "status": status, "tags": []string{}, "commitmentStatus": "open",
		"validFrom": "2026-10-01T00:00:00.000Z", "validTo": validTo,
		"recordedAt": "2026-10-01T00:00:00.000Z", "createdAt": "2026-10-01T00:00:00.000Z",
	})
	return string(b)
}

func strPtr(s string) *string { return &s }

func projectSel(project string) map[string]any {
	return map[string]any{"kind": "project", "project": project}
}

func scopeProjectSel(scope, project string, include bool) map[string]any {
	return map[string]any{"kind": "scope_project", "scope": scope, "project": project, "includeUnscoped": include}
}

const meBody = `{"id":"11111111-1111-4111-8111-111111111111","email":"owner@example.test"}`
