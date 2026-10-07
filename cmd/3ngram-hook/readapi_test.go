// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestClassifyReadFailure(t *testing.T) {
	live := context.Background()
	expired, cancel := context.WithTimeout(context.Background(), 0)
	defer cancel()
	stopped, stop := context.WithCancel(context.Background())
	stop()

	cases := []struct {
		name   string
		ctx    context.Context
		status int
		err    error
		want   string
	}{
		{"401", live, 401, nil, kindAuth},
		{"403", live, 403, nil, kindAuth},
		{"404", live, 404, nil, kindNotFound},
		{"429", live, 429, nil, kindRateLimited},
		{"503", live, 503, nil, kindUnavailable},
		{"500", live, 500, nil, kindUnavailable},
		{"400", live, 400, nil, kindBadRequest},
		{"302", live, 302, nil, kindBadRequest},
		{"transport", live, 0, errors.New("connection refused"), kindUnavailable},
		{"body read", live, 200, errors.New("unexpected EOF"), kindBadResponse},
		{"deadline wins", expired, 0, errors.New("connection refused"), kindTimeout},
		{"cancel wins", stopped, 503, nil, kindCancelled},
	}
	for _, tc := range cases {
		if got := classifyReadFailure(tc.ctx, "route", tc.status, tc.err).Kind; got != tc.want {
			t.Errorf("%s: kind = %s, want %s", tc.name, got, tc.want)
		}
	}
}

func TestContextFingerprint(t *testing.T) {
	no, yes := false, true
	base := briefingSelector{Kind: "scope_project", Scope: "work", Project: "demo", IncludeUnscoped: &no}
	fp := contextFingerprint("https://api.example.test", "key-a", base)
	if fp != contextFingerprint("https://api.example.test", "key-a", base) {
		t.Fatal("the fingerprint must be stable")
	}
	if len(fp) != 16 {
		t.Fatalf("fingerprint %q is not 16 hex characters", fp)
	}
	widened := base
	widened.IncludeUnscoped = &yes
	variants := map[string]string{
		"backend":  contextFingerprint("https://other.example.test", "key-a", base),
		"key":      contextFingerprint("https://api.example.test", "key-b", base),
		"scope":    contextFingerprint("https://api.example.test", "key-a", briefingSelector{Kind: "scope_project", Scope: "personal", Project: "demo", IncludeUnscoped: &no}),
		"project":  contextFingerprint("https://api.example.test", "key-a", briefingSelector{Kind: "scope_project", Scope: "work", Project: "other", IncludeUnscoped: &no}),
		"unscoped": contextFingerprint("https://api.example.test", "key-a", widened),
	}
	for name, other := range variants {
		if other == fp {
			t.Errorf("changing the %s must change the fingerprint", name)
		}
	}
	if strings.Contains(fp, "key-a") {
		t.Fatal("the fingerprint must not embed the key")
	}
}

// A redirect must not carry the key to another host: the read client refuses
// to follow it at all.
func TestAPIGetDoesNotFollowRedirects(t *testing.T) {
	var elsewhereHits atomic.Int32
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		elsewhereHits.Add(1)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer elsewhere.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL+"/steal", http.StatusFound)
	}))
	defer origin.Close()
	t.Setenv("THREENGRAM_API_BASE", origin.URL)
	t.Setenv("THREENGRAM_API_KEY", testAPIKey)

	var out map[string]any
	err := apiGet(context.Background(), "briefing", "/api/v1/briefing", &out)

	if err == nil || err.Kind != kindBadRequest || err.Status != http.StatusFound {
		t.Fatalf("err = %+v", err)
	}
	if elsewhereHits.Load() != 0 {
		t.Fatal("the redirect target was contacted")
	}
}

func TestAPIHost(t *testing.T) {
	if got := apiHost("https://api.3ngram.ai/some/path?x=1"); got != "api.3ngram.ai" {
		t.Fatalf("apiHost = %q", got)
	}
}

// The read-only guarantee is structural: every file of the commitments data
// path is parsed, and none may call the write-capable request helper, the raw
// request constructor, the sentinel writer, or anything that writes a file.
// http.NewRequestWithContext is allowed only with http.MethodGet.
func TestCommitmentsDataPathIsReadOnly(t *testing.T) {
	files, err := filepath.Glob("commitments*.go")
	if err != nil {
		t.Fatal(err)
	}
	files = append(files, "readapi.go")
	forbidden := map[string]bool{
		"apiRequest": true, "warnMissingAPIKey": true, "NewRequest": true,
		"WriteFile": true, "Create": true, "OpenFile": true, "MkdirAll": true,
		"Mkdir": true, "Remove": true, "RemoveAll": true, "Rename": true, "Post": true, "PostForm": true,
	}
	fset := token.NewFileSet()
	checked := 0
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		checked++
		file, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			callee := calleeName(call.Fun)
			if forbidden[callee] {
				t.Errorf("%s: %s calls %s, which the read-only data path must not", name, fset.Position(call.Pos()), callee)
			}
			if callee == "NewRequestWithContext" {
				if len(call.Args) < 2 || calleeName(call.Args[1]) != "MethodGet" {
					t.Errorf("%s: %s builds a request that is not http.MethodGet", name, fset.Position(call.Pos()))
				}
			}
			return true
		})
	}
	if checked < 3 {
		t.Fatalf("only %d data-path files were checked", checked)
	}
}

func calleeName(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.Ident:
		return e.Name
	case *ast.SelectorExpr:
		return e.Sel.Name
	}
	return ""
}
