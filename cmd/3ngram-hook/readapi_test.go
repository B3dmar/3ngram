// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
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
	err := apiGet(context.Background(), resolveReadConfig(), "briefing", "/api/v1/briefing", &out)

	if err == nil || err.Kind != kindBadRequest || err.Status != http.StatusFound {
		t.Fatalf("err = %+v", err)
	}
	if elsewhereHits.Load() != 0 {
		t.Fatal("the redirect target was contacted")
	}
}

func TestMemoryPathEscapesAndRefusesDotSegments(t *testing.T) {
	for _, bad := range []string{"", ".", ".."} {
		if _, ok := memoryPath(bad, ""); ok {
			t.Errorf("memoryPath(%q) must refuse", bad)
		}
	}
	got, ok := memoryPath("a/b?c#d", "/history")
	if !ok || got != "/api/v1/memories/a%2Fb%3Fc%23d/history" {
		t.Fatalf("memoryPath = %q, %v", got, ok)
	}
}

func TestAPIHost(t *testing.T) {
	if got := apiHost("https://api.3ngram.ai/some/path?x=1"); got != "api.3ngram.ai" {
		t.Fatalf("apiHost = %q", got)
	}
}

// The read-only guarantee is structural. Every non-test file of the
// commitments data path (named commitments*.go or readapi*.go) is parsed and
// held to an allowlist: no reference at all to the write-capable request helper
// or the sentinel writer, no http convenience call or default client, no os
// member beyond reading the environment and the working directory, no exec or
// ioutil import, Do only on readClient, and requests only as exactly
// http.MethodGet.
func TestCommitmentsDataPathIsReadOnly(t *testing.T) {
	var files []string
	for _, pattern := range []string{"commitments*.go", "readapi*.go"} {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range matches {
			if !strings.HasSuffix(m, "_test.go") {
				files = append(files, m)
			}
		}
	}
	if len(files) < 3 {
		t.Fatalf("only %d data-path files found: %v", len(files), files)
	}
	for _, name := range files {
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		for _, v := range readOnlyViolations(t, name, string(src)) {
			t.Error(v)
		}
	}
}

// The checker itself is tested against a file that breaks every rule, so a
// checker that silently stopped matching would fail here, not pass everything.
func TestReadOnlyCheckerCatchesViolations(t *testing.T) {
	const bad = `package main
import (
	"io/ioutil"
	"net/http"
	"os"
	"os/exec"
)
func bad() {
	f := apiRequest
	_ = f
	warnMissingAPIKey()
	_, _ = http.Get("x")
	_, _ = http.Post("x", "", nil)
	_ = http.DefaultClient
	_ = os.WriteFile("x", nil, 0)
	_ = os.Remove("x")
	_ = ioutil.Discard
	_ = exec.Command("x")
	var c http.Client
	_, _ = c.Do(nil)
	_, _ = http.NewRequestWithContext(nil, "POST", "x", nil)
	_, _ = http.NewRequestWithContext(nil, other.MethodGet, "x", nil)
}`
	got := strings.Join(readOnlyViolations(t, "bad.go", bad), "\n")
	for _, want := range []string{
		"import io/ioutil", "import os/exec", "references apiRequest", "references warnMissingAPIKey",
		"http.Get", "http.Post", "http.DefaultClient", "os.WriteFile", "os.Remove",
		"Do on something other than readClient", "not exactly http.MethodGet",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("checker missed %q in:\n%s", want, got)
		}
	}
	if n := strings.Count(got, "not exactly http.MethodGet"); n != 2 {
		t.Errorf("both non-GET requests must be flagged, got %d", n)
	}

	const github = `package main
import "os/exec"
func lookups(ctx context.Context, p, verb string) {
	_ = exec.CommandContext(ctx, "gh", "api", "--method", "GET", p)
	_ = exec.CommandContext(ctx, "gh", "api", "--method", "POST", p)
	_ = exec.CommandContext(ctx, "gh", "api", "--method", verb, p)
	_ = exec.CommandContext(ctx, "sh", "-c", "gh", "api", p)
	_ = exec.CommandContext(ctx, "gh", "api", "--method", "GET", p, "-f", "x=1")
	_ = exec.Command("gh")
	_ = exec.LookPath
}`
	got = strings.Join(readOnlyViolations(t, "commitments_github.go", github), "\n")
	if strings.Contains(got, "import os/exec") {
		t.Error("commitments_github.go may import os/exec")
	}
	if n := strings.Count(got, "not exactly gh api --method GET"); n != 4 {
		t.Errorf("four non-GET gh calls must be flagged, got %d:\n%s", n, got)
	}
	for _, want := range []string{"exec.Command", "exec.LookPath"} {
		if !strings.Contains(got, "uses "+want) {
			t.Errorf("checker missed %s:\n%s", want, got)
		}
	}
	if strings.Count(got, "\n")+1 != 6 {
		t.Errorf("the one GET call must pass, got:\n%s", got)
	}
}

var allowedOSMembers = map[string]bool{
	"Getenv": true, "Getwd": true, "Stdout": true, "Stderr": true, "Interrupt": true,
}

func readOnlyViolations(t *testing.T, name, src string) []string {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, name, src, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	flag := func(n ast.Node, msg string) {
		out = append(out, fmt.Sprintf("%s: %s", fset.Position(n.Pos()), msg))
	}
	// commitments_github.go alone may run a process, and only `gh api
	// --method GET <path>`; every other data-path file may not import exec.
	githubFile := filepath.Base(name) == "commitments_github.go"
	for _, imp := range file.Imports {
		path := strings.Trim(imp.Path.Value, `"`)
		if path == "io/ioutil" || (path == "os/exec" && !githubFile) {
			flag(imp, "import "+path)
		}
	}
	ast.Inspect(file, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.Ident:
			if node.Name == "apiRequest" || node.Name == "warnMissingAPIKey" {
				flag(node, "references "+node.Name)
			}
		case *ast.SelectorExpr:
			if pkg, ok := node.X.(*ast.Ident); ok {
				switch {
				case pkg.Name == "http" && map[string]bool{"Get": true, "Head": true, "Post": true, "PostForm": true, "NewRequest": true, "DefaultClient": true}[node.Sel.Name]:
					flag(node, "uses http."+node.Sel.Name)
				case pkg.Name == "os" && !allowedOSMembers[node.Sel.Name]:
					flag(node, "uses os."+node.Sel.Name)
				case pkg.Name == "exec" && node.Sel.Name != "CommandContext" && node.Sel.Name != "ErrNotFound":
					flag(node, "uses exec."+node.Sel.Name)
				}
			}
		case *ast.CallExpr:
			sel, ok := node.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if sel.Sel.Name == "Do" {
				if recv, ok := sel.X.(*ast.Ident); !ok || recv.Name != "readClient" {
					flag(node, "calls Do on something other than readClient")
				}
			}
			if sel.Sel.Name == "NewRequestWithContext" && (len(node.Args) < 2 || !isHTTPMethodGet(node.Args[1])) {
				flag(node, "builds a request that is not exactly http.MethodGet")
			}
			if pkg, ok := sel.X.(*ast.Ident); ok && pkg.Name == "exec" && sel.Sel.Name == "CommandContext" && !isGHAPIGet(node.Args) {
				flag(node, "runs a command that is not exactly gh api --method GET")
			}
		}
		return true
	})
	return out
}

// isGHAPIGet reports whether CommandContext's arguments are ctx, then the
// string literals "gh", "api", "--method", "GET", then one path.
func isGHAPIGet(args []ast.Expr) bool {
	if len(args) != 6 {
		return false
	}
	for i, want := range []string{"gh", "api", "--method", "GET"} {
		lit, ok := args[i+1].(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING || lit.Value != strconv.Quote(want) {
			return false
		}
	}
	return true
}

func isHTTPMethodGet(expr ast.Expr) bool {
	sel, ok := expr.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	pkg, ok := sel.X.(*ast.Ident)
	return ok && pkg.Name == "http" && sel.Sel.Name == "MethodGet"
}
