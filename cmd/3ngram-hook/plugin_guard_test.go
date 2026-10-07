// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// guardFixture is a user config dir and a project dir with optional settings
// files, and nothing else on the machine.
type guardFixture struct {
	env guardEnv
}

func newGuardFixture(t *testing.T) *guardFixture {
	t.Helper()
	root := t.TempDir()
	f := &guardFixture{env: guardEnv{
		configDir:  filepath.Join(root, "config"),
		projectDir: filepath.Join(root, "project"),
		managed:    []string{filepath.Join(root, "managed", "managed-settings.json")},
	}}
	for _, dir := range []string{f.env.configDir, filepath.Join(f.env.projectDir, ".claude"), filepath.Dir(f.env.managed[0])} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func (f *guardFixture) user(t *testing.T, body string) {
	f.write(t, filepath.Join(f.env.configDir, "settings.json"), body)
}
func (f *guardFixture) local(t *testing.T, body string) {
	f.write(t, filepath.Join(f.env.projectDir, ".claude", "settings.local.json"), body)
}
func (f *guardFixture) managed(t *testing.T, body string) { f.write(t, f.env.managed[0], body) }

func (f *guardFixture) write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func hooksJSON(event, matcher string, commands ...string) string {
	var handlers []string
	for _, c := range commands {
		handlers = append(handlers, `{"type":"command","command":`+quote(c)+`}`)
	}
	m := ""
	if matcher != "-" {
		m = `"matcher":` + quote(matcher) + `,`
	}
	return `{"hooks":{` + quote(event) + `:[{` + m + `"hooks":[` + strings.Join(handlers, ",") + `]}]}}`
}

func quote(s string) string {
	var b bytes.Buffer
	b.WriteByte('"')
	for _, r := range s {
		if r == '"' || r == '\\' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('"')
	return b.String()
}

func TestGuardDefersOnlyWhenSettingsCoverThisInstance(t *testing.T) {
	cases := []struct {
		name     string
		settings string
		sub      string
		input    string
		want     bool
	}{
		{"settings registers it for every source", hooksJSON("SessionStart", "-", "3ngram-hook briefing"), "briefing", `{"source":"resume"}`, true},
		{"star matcher", hooksJSON("SessionStart", "*", "3ngram-hook briefing"), "briefing", `{"source":"compact"}`, true},
		{"partial coverage: startup only, plugin runs on resume", hooksJSON("SessionStart", "startup", "3ngram-hook briefing"), "briefing", `{"source":"resume"}`, false},
		{"partial coverage: startup only, deferred on startup", hooksJSON("SessionStart", "startup", "3ngram-hook briefing"), "briefing", `{"source":"startup"}`, true},
		{"exact list", hooksJSON("SessionStart", "startup|resume|clear", "3ngram-hook briefing"), "briefing", `{"source":"clear"}`, true},
		{"exact list misses fork", hooksJSON("SessionStart", "startup|resume|clear|compact", "3ngram-hook briefing"), "briefing", `{"source":"fork"}`, false},
		{"comma list", hooksJSON("SessionStart", "startup, resume", "3ngram-hook briefing"), "briefing", `{"source":"resume"}`, true},
		{"regex matcher", hooksJSON("PreToolUse", "^(Edit|Write)$", "3ngram-hook precheck"), "precheck", `{"tool_name":"Write"}`, true},
		{"unanchored regex", hooksJSON("PreToolUse", "Edit.*", "3ngram-hook precheck"), "precheck", `{"tool_name":"NotebookEdit"}`, true},
		{"regex RE2 cannot compile claims nothing", hooksJSON("PreToolUse", "(?<=x)Edit", "3ngram-hook precheck"), "precheck", `{"tool_name":"Edit"}`, false},
		{"exact tool list", hooksJSON("PreToolUse", "Edit|Write|NotebookEdit", "3ngram-hook precheck"), "precheck", `{"tool_name":"Edit"}`, true},
		{"other tool", hooksJSON("PreToolUse", "Edit|Write", "3ngram-hook precheck"), "precheck", `{"tool_name":"Bash"}`, false},
		{"heartbeat in settings defers stop", hooksJSON("Stop", "-", "3ngram-hook heartbeat"), "stop", `{}`, true},
		{"stop in settings defers heartbeat", hooksJSON("Stop", "-", "3ngram-hook stop"), "heartbeat", `{}`, true},
		{"Stop ignores a matcher", hooksJSON("Stop", "anything", "3ngram-hook stop"), "stop", `{}`, true},
		{"full path and --agent still count", hooksJSON("SessionEnd", "-", "/Users/x/.local/bin/3ngram-hook close --agent claude-code"), "close", `{"reason":"clear"}`, true},
		{"SessionEnd reason matcher", hooksJSON("SessionEnd", "logout", "3ngram-hook close"), "close", `{"reason":"clear"}`, false},
		{"a precheck in settings does not cover the briefing", hooksJSON("PreToolUse", "-", "3ngram-hook precheck"), "briefing", `{"source":"startup"}`, false},
		{"another event does not count", hooksJSON("SessionEnd", "-", "3ngram-hook briefing"), "briefing", `{"source":"startup"}`, false},
		{"shell-wrapped command claims nothing", hooksJSON("SessionStart", "-", "sh -c '3ngram-hook briefing'"), "briefing", `{"source":"startup"}`, false},
		{"composite command claims nothing", hooksJSON("SessionStart", "-", "3ngram-hook briefing && echo done"), "briefing", `{"source":"startup"}`, false},
		{"env assignment claims nothing", hooksJSON("SessionStart", "-", "THREENGRAM_SCOPE=work 3ngram-hook briefing"), "briefing", `{"source":"startup"}`, false},
		{"a wrapper script claims nothing", hooksJSON("Stop", "-", "~/.claude/hooks/precompact-preserve.sh"), "stop", `{}`, false},
		{"another plugin copy does not count", hooksJSON("SessionStart", "-", "3ngram-hook briefing --via plugin"), "briefing", `{"source":"startup"}`, false},
		{"no instance value with a matcher claims nothing", hooksJSON("SessionStart", "startup", "3ngram-hook briefing"), "briefing", `{}`, false},
		{"malformed settings claim nothing", `{"hooks":`, "briefing", `{"source":"startup"}`, false},
		{"disableAllHooks claims nothing", `{"disableAllHooks":true,` + hooksJSON("Stop", "-", "3ngram-hook stop")[1:], "stop", `{}`, false},
		{"an unguarded subcommand is never deferred", hooksJSON("SessionStart", "-", "3ngram-hook verify"), "verify", `{}`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newGuardFixture(t)
			f.user(t, tc.settings)
			if got := deferToSettings(tc.sub, []byte(tc.input), f.env); got != tc.want {
				t.Fatalf("deferToSettings = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestGuardReadsEverySettingsSource(t *testing.T) {
	for name, write := range map[string]func(*guardFixture, *testing.T, string){
		"user":    (*guardFixture).user,
		"local":   (*guardFixture).local,
		"managed": (*guardFixture).managed,
	} {
		t.Run(name, func(t *testing.T) {
			f := newGuardFixture(t)
			write(f, t, hooksJSON("Stop", "-", "3ngram-hook stop"))
			if !deferToSettings("stop", []byte(`{}`), f.env) {
				t.Fatalf("a %s settings registration must be seen", name)
			}
		})
	}
	if deferToSettings("stop", []byte(`{}`), newGuardFixture(t).env) {
		t.Fatal("with no settings anywhere, the plugin copy runs")
	}
}

func TestGuardExecFormHandler(t *testing.T) {
	f := newGuardFixture(t)
	f.user(t, `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/opt/bin/3ngram-hook","args":["briefing","--agent","claude-code"]}]}]}}`)
	if !deferToSettings("briefing", []byte(`{"source":"startup"}`), f.env) {
		t.Fatal("an exec-form registration counts")
	}
}

func TestViaPlugin(t *testing.T) {
	via, rest := viaPlugin([]string{"--agent", "claude-code", "--via", "plugin"})
	if !via || strings.Join(rest, " ") != "--agent claude-code" {
		t.Fatalf("via=%v rest=%v", via, rest)
	}
	if via, _ := viaPlugin([]string{"--agent", "claude-code"}); via {
		t.Fatal("no marker, no guard")
	}
	if via, _ := viaPlugin([]string{"--via", "settings"}); via {
		t.Fatal("only `--via plugin` is the plugin's marker")
	}
}

// End to end through the built binary: a plugin copy defers before doing
// anything when settings own the event, runs on the same stdin when they do
// not, and a settings hook never consults the guard at all.
func TestGuardEndToEnd(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "3ngram-hook")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	var mu sync.Mutex
	closes := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/agent-sessions/close" {
			mu.Lock()
			closes++
			mu.Unlock()
		}
		_, _ = w.Write([]byte(`{"closed":true}`))
	}))
	defer srv.Close()
	count := func() int {
		mu.Lock()
		defer mu.Unlock()
		return closes
	}
	isolateKeyFiles(t)
	config := t.TempDir()
	project := t.TempDir()
	run := func(stdin string, args ...string) {
		cmd := exec.Command(bin, args...)
		// Outside any git worktree: the lifecycle hooks skip secondary
		// worktrees, and this test may run from one.
		cmd.Dir = project
		cmd.Stdin = strings.NewReader(stdin)
		cmd.Env = append(os.Environ(), "CLAUDE_CONFIG_DIR="+config, "CLAUDE_PROJECT_DIR="+project, "CLAUDECODE=1",
			"THREENGRAM_API_BASE="+srv.URL, "THREENGRAM_API_KEY="+testAPIKey)
		cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
		_ = cmd.Run()
	}
	stdin := `{"session_id":"s1","reason":"clear"}`

	// Settings own SessionEnd: the plugin copy stands down.
	if err := os.WriteFile(filepath.Join(config, "settings.json"), []byte(hooksJSON("SessionEnd", "-", "3ngram-hook close")), 0o644); err != nil {
		t.Fatal(err)
	}
	run(stdin, "close", "--via", "plugin")
	if n := count(); n != 0 {
		t.Fatalf("a deferred plugin copy made %d requests", n)
	}

	// The settings copy itself runs, guard or no guard.
	run(stdin, "close")
	if count() != 1 {
		t.Fatalf("the settings copy must run: %d closes", count())
	}

	// Settings cover only logout: the plugin copy runs, with the stdin it read.
	if err := os.WriteFile(filepath.Join(config, "settings.json"), []byte(hooksJSON("SessionEnd", "logout", "3ngram-hook close")), 0o644); err != nil {
		t.Fatal(err)
	}
	run(stdin, "close", "--via", "plugin")
	if count() != 2 {
		t.Fatalf("an uncovered instance runs the plugin copy: %d closes", count())
	}
}
