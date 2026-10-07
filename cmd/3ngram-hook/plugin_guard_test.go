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
	// bin is an executable 3ngram-hook stand-in, also first on PATH, so a
	// registration names a program that starts, on any machine.
	bin string
}

func newGuardFixture(t *testing.T) *guardFixture {
	t.Helper()
	root := t.TempDir()
	f := &guardFixture{env: guardEnv{
		configDir:   filepath.Join(root, "config"),
		projectDir:  filepath.Join(root, "project"),
		managedDir:  filepath.Join(root, "managed"),
		opaqueAdmin: []string{filepath.Join(root, "mdm", "com.anthropic.claudecode.plist")},
	}}
	for _, dir := range []string{f.env.configDir, filepath.Join(f.env.projectDir, ".claude"), f.env.managedDir, filepath.Join(f.env.managedDir, "managed-settings.d"), filepath.Join(root, "mdm"), filepath.Join(root, "bin")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	f.bin = filepath.Join(root, "bin", "3ngram-hook")
	if err := os.WriteFile(f.bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Join(root, "bin"))
	return f
}

func (f *guardFixture) user(t *testing.T, body string) {
	f.write(t, filepath.Join(f.env.configDir, "settings.json"), body)
}
func (f *guardFixture) local(t *testing.T, body string) {
	f.write(t, filepath.Join(f.env.projectDir, ".claude", "settings.local.json"), body)
}
func (f *guardFixture) managed(t *testing.T, body string) {
	f.write(t, filepath.Join(f.env.managedDir, "managed-settings.json"), body)
}
func (f *guardFixture) dropIn(t *testing.T, name, body string) {
	f.write(t, filepath.Join(f.env.managedDir, "managed-settings.d", name), body)
}

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
		{"comma list", hooksJSON("SessionStart", "startup,resume", "3ngram-hook briefing"), "briefing", `{"source":"resume"}`, true},
		{"spaces around comma alternatives are trimmed", hooksJSON("SessionStart", "startup, resume", "3ngram-hook briefing"), "briefing", `{"source":"resume"}`, true},
		{"spaces around pipe alternatives are trimmed", hooksJSON("PreToolUse", " Edit | Write ", "3ngram-hook precheck"), "precheck", `{"tool_name":"Write"}`, true},
		{"a space inside an alternative is not trimmed away", hooksJSON("PreToolUse", "Edit Write", "3ngram-hook precheck"), "precheck", `{"tool_name":"Edit"}`, false},
		{"a matcher of spaces only claims nothing", hooksJSON("PreToolUse", "  ", "3ngram-hook precheck"), "precheck", `{"tool_name":"Edit"}`, false},
		{"an empty trailing alternative adds nothing", hooksJSON("PreToolUse", "Write|", "3ngram-hook precheck"), "precheck", `{"tool_name":"Edit"}`, false},
		{"fork listed", hooksJSON("SessionStart", "startup|resume|clear|compact|fork", "3ngram-hook briefing"), "briefing", `{"source":"fork"}`, true},
		{"inline regex flag claims nothing", hooksJSON("PreToolUse", "(?i)edit", "3ngram-hook precheck"), "precheck", `{"tool_name":"Edit"}`, false},
		{"Go-only anchor claims nothing", hooksJSON("PreToolUse", `\AEdit`, "3ngram-hook precheck"), "precheck", `{"tool_name":"Edit"}`, false},
		{"escape class claims nothing", hooksJSON("PreToolUse", `Edit\w*`, "3ngram-hook precheck"), "precheck", `{"tool_name":"Edit"}`, false},
		{"regex matcher", hooksJSON("PreToolUse", "^(Edit|Write)$", "3ngram-hook precheck"), "precheck", `{"tool_name":"Write"}`, true},
		{"unanchored regex", hooksJSON("PreToolUse", "Edit.*", "3ngram-hook precheck"), "precheck", `{"tool_name":"NotebookEdit"}`, true},
		{"regex RE2 cannot compile claims nothing", hooksJSON("PreToolUse", "(?<=x)Edit", "3ngram-hook precheck"), "precheck", `{"tool_name":"Edit"}`, false},
		{"exact tool list", hooksJSON("PreToolUse", "Edit|Write|NotebookEdit", "3ngram-hook precheck"), "precheck", `{"tool_name":"Edit"}`, true},
		{"other tool", hooksJSON("PreToolUse", "Edit|Write", "3ngram-hook precheck"), "precheck", `{"tool_name":"Bash"}`, false},
		{"heartbeat in settings defers stop", hooksJSON("Stop", "-", "3ngram-hook heartbeat"), "stop", `{}`, true},
		{"stop in settings defers heartbeat", hooksJSON("Stop", "-", "3ngram-hook stop"), "heartbeat", `{}`, true},
		{"Stop ignores a matcher", hooksJSON("Stop", "anything", "3ngram-hook stop"), "stop", `{}`, true},
		{"a null matcher claims nothing", `{"hooks":{"SessionStart":[{"matcher":null,"hooks":[{"type":"command","command":"3ngram-hook briefing"}]}]}}`, "briefing", `{"source":"startup"}`, false},
		{"a null matcher claims nothing on Stop too", `{"hooks":{"Stop":[{"matcher":null,"hooks":[{"type":"command","command":"3ngram-hook stop"}]}]}}`, "stop", `{}`, false},
		{"a non-string matcher claims nothing", `{"hooks":{"PreToolUse":[{"matcher":["Edit"],"hooks":[{"type":"command","command":"3ngram-hook precheck"}]}]}}`, "precheck", `{"tool_name":"Edit"}`, false},
		{"a path to a binary that is gone claims nothing", hooksJSON("SessionEnd", "-", "/nonexistent/bin/3ngram-hook close"), "close", `{"reason":"clear"}`, false},
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
			// The hook runs in the project the session started in.
			if !deferToSettings("stop", []byte(`{"cwd":`+quote(f.env.projectDir)+`}`), f.env) {
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
	f.user(t, `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":`+quote(f.bin)+`,"args":["briefing","--agent","claude-code"]}]}]}}`)
	if !deferToSettings("briefing", []byte(`{"source":"startup"}`), f.env) {
		t.Fatal("an exec-form registration counts")
	}
}

func TestGuardFullPathCounts(t *testing.T) {
	f := newGuardFixture(t)
	f.user(t, hooksJSON("SessionEnd", "-", f.bin+" close --agent claude-code"))
	if !deferToSettings("close", []byte(`{"reason":"clear"}`), f.env) {
		t.Fatal("a full path to an executable 3ngram-hook counts")
	}
}

// A handler field that changes when or whether the hook runs makes it claim
// nothing, as does a handler with no type or less time than the plugin copy.
func TestGuardHandlerFieldsThatChangeWhenItRuns(t *testing.T) {
	cases := map[string]struct {
		handler string
		want    bool
	}{
		"plain":          {`{"type":"command","command":"3ngram-hook precheck"}`, true},
		"status message": {`{"type":"command","command":"3ngram-hook precheck","statusMessage":"3ngram"}`, true},
		"enough time":    {`{"type":"command","command":"3ngram-hook precheck","timeout":2}`, true},
		"exec form, empty args, command with a space": {`{"type":"command","command":"3ngram-hook precheck","args":[]}`, false},
		"exec form, null args":                        {`{"type":"command","command":"3ngram-hook","args":null}`, false},
		"exec form, args name the subcommand":         {`{"type":"command","command":"3ngram-hook","args":["precheck"]}`, true},
		"less time":                                   {`{"type":"command","command":"3ngram-hook precheck","timeout":1}`, false},
		"permission rule (if)":                        {`{"type":"command","command":"3ngram-hook precheck","if":"Edit(*.ts)"}`, false},
		"async":                                       {`{"type":"command","command":"3ngram-hook precheck","async":true}`, false},
		"once (ignored in settings files)":            {`{"type":"command","command":"3ngram-hook precheck","once":true}`, true},
		"once false":                                  {`{"type":"command","command":"3ngram-hook precheck","once":false}`, true},
		"shell":                                       {`{"type":"command","command":"3ngram-hook precheck","shell":"powershell"}`, false},
		"no type":                                     {`{"command":"3ngram-hook precheck"}`, false},
		"another type":                                {`{"type":"http","command":"3ngram-hook precheck"}`, false},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			f := newGuardFixture(t)
			f.user(t, `{"hooks":{"PreToolUse":[{"matcher":"Edit|Write","hooks":[`+tc.handler+`]}]}}`)
			if got := deferToSettings("precheck", []byte(`{"tool_name":"Edit"}`), f.env); got != tc.want {
				t.Fatalf("deferToSettings = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestReadHookInputFlagsOversizedInput(t *testing.T) {
	small, complete := readHookInput(strings.NewReader(`{"source":"startup"}`))
	if !complete || string(small) != `{"source":"startup"}` {
		t.Fatal("a small input is read whole")
	}
	big := strings.Repeat("x", maxHookInput+10)
	prefix, complete := readHookInput(strings.NewReader(big))
	if complete || len(prefix) != maxHookInput+1 {
		t.Fatalf("an oversized input is flagged: complete=%v len=%d", complete, len(prefix))
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
		// The built binary is the 3ngram-hook the settings name, found on
		// PATH as it would be in a session; nothing else on the machine is.
		cmd.Env = append(os.Environ(), "CLAUDE_CONFIG_DIR="+config, "CLAUDE_PROJECT_DIR="+project, "CLAUDECODE=1",
			"THREENGRAM_API_BASE="+srv.URL, "THREENGRAM_API_KEY="+testAPIKey,
			"PATH="+filepath.Dir(bin)+string(os.PathListSeparator)+"/usr/bin:/bin")
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

// The time a settings copy needs is what the subcommand takes, not the plugin
// copy's own timeout: the documented 5 s Stop registration covers the 2 s
// heartbeat, and only an armed nudge needs the documented 10 s.
func TestGuardTimeoutIsWhatTheSubcommandNeeds(t *testing.T) {
	stop := func(timeout string) string {
		return `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"3ngram-hook stop","timeout":` + timeout + `}]}]}}`
	}
	cases := []struct {
		name, settings, sub, input, nudge string
		want                              bool
	}{
		{"documented Stop, 5 s", stop("5"), "stop", `{}`, "", true},
		{"Stop below the heartbeat", stop("2"), "stop", `{}`, "", false},
		{"armed nudge, 5 s is too little", stop("5"), "stop", `{}`, "1", false},
		{"armed nudge, documented 10 s", stop("10"), "stop", `{}`, "1", true},
		{"documented close, 5 s", `{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"3ngram-hook close","timeout":5}]}]}}`, "close", `{"reason":"clear"}`, "", true},
		{"close at 2 s", `{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"3ngram-hook close","timeout":2}]}]}}`, "close", `{"reason":"clear"}`, "", true},
		{"briefing below 10 s", `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"3ngram-hook briefing","timeout":5}]}]}}`, "briefing", `{"source":"startup"}`, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(stopNudgeEnvVar, tc.nudge)
			f := newGuardFixture(t)
			f.user(t, tc.settings)
			if got := deferToSettings(tc.sub, []byte(tc.input), f.env); got != tc.want {
				t.Fatalf("deferToSettings = %v, want %v", got, tc.want)
			}
		})
	}
}

// allowManagedHooksOnly blocks user, project and local hooks but exempts a
// plugin policy force-enables, so only a managed hook covers an event then.
// An admin source the guard cannot read may set that or outrank the files,
// so it makes every settings hook claim nothing.
func TestGuardHonoursManagedPolicy(t *testing.T) {
	covered := hooksJSON("Stop", "-", "3ngram-hook stop")
	hooksOnly := `{"allowManagedHooksOnly":true}`
	cases := []struct {
		name  string
		setup func(*guardFixture, *testing.T)
		want  bool
	}{
		{"user hook, no policy", func(f *guardFixture, t *testing.T) { f.user(t, covered) }, true},
		{"user hook blocked by the managed file", func(f *guardFixture, t *testing.T) {
			f.user(t, covered)
			f.managed(t, hooksOnly)
		}, false},
		{"user hook blocked by a drop-in", func(f *guardFixture, t *testing.T) {
			f.local(t, covered)
			f.dropIn(t, "20-hooks.json", hooksOnly)
		}, false},
		{"a hidden drop-in is ignored", func(f *guardFixture, t *testing.T) {
			f.user(t, covered)
			f.dropIn(t, ".20-hooks.json", hooksOnly)
		}, true},
		{"a managed hook still covers under the lock", func(f *guardFixture, t *testing.T) {
			f.managed(t, `{"allowManagedHooksOnly":true,`+covered[1:])
		}, true},
		{"a drop-in hook covers", func(f *guardFixture, t *testing.T) { f.dropIn(t, "10-hooks.json", covered) }, true},
		{"an unreadable managed file claims nothing", func(f *guardFixture, t *testing.T) {
			f.user(t, covered)
			f.managed(t, `{"allowManagedHooksOnly":`)
		}, false},
		{"a managed preferences profile claims nothing", func(f *guardFixture, t *testing.T) {
			f.user(t, covered)
			f.write(t, f.env.opaqueAdmin[0], "bplist00")
		}, false},
		{"a server-managed policy claims nothing", func(f *guardFixture, t *testing.T) {
			f.user(t, covered)
			f.write(t, filepath.Join(f.env.configDir, "remote-settings.json"), `{"permissions":{"deny":[]}}`)
		}, false},
		{"a lock that is not a boolean claims nothing", func(f *guardFixture, t *testing.T) {
			f.user(t, covered)
			f.managed(t, `{"allowManagedHooksOnly":"yes"}`)
		}, false},
		{"a managed file that is a directory claims nothing", func(f *guardFixture, t *testing.T) {
			f.user(t, covered)
			if err := os.Mkdir(filepath.Join(f.env.managedDir, "managed-settings.json"), 0o755); err != nil {
				t.Fatal(err)
			}
		}, false},
		{"an unreadable drop-in directory claims nothing", func(f *guardFixture, t *testing.T) {
			f.user(t, covered)
			dropIns := filepath.Join(f.env.managedDir, "managed-settings.d")
			if err := os.Remove(dropIns); err != nil {
				t.Fatal(err)
			}
			f.write(t, dropIns, "not a directory")
		}, false},
		{"a malformed server-managed cache claims nothing", func(f *guardFixture, t *testing.T) {
			f.user(t, covered)
			f.write(t, filepath.Join(f.env.configDir, "remote-settings.json"), `{"permissions":`)
		}, false},
		{"a managed policyHelper claims nothing", func(f *guardFixture, t *testing.T) {
			f.managed(t, `{"policyHelper":{"path":"/usr/local/bin/policy"},`+covered[1:])
		}, false},
		{"a null policyHelper is none", func(f *guardFixture, t *testing.T) {
			f.user(t, covered)
			f.managed(t, `{"policyHelper":null}`)
		}, true},
		{"an empty server-managed cache is no policy", func(f *guardFixture, t *testing.T) {
			f.user(t, covered)
			f.write(t, filepath.Join(f.env.configDir, "remote-settings.json"), `{}`)
		}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newGuardFixture(t)
			tc.setup(f, t)
			if got := deferToSettings("stop", []byte(`{}`), f.env); got != tc.want {
				t.Fatalf("deferToSettings = %v, want %v", got, tc.want)
			}
		})
	}
}

// Project settings count only while the hook runs in the project the session
// started in: after a /cd, Claude Code reads project settings from the new
// directory while CLAUDE_PROJECT_DIR stays put, so the starting project's
// registrations may no longer be active. User settings always count.
func TestGuardProjectSettingsFollowTheHookDirectory(t *testing.T) {
	stop := hooksJSON("Stop", "-", "3ngram-hook stop")
	input := func(cwd string) []byte { return []byte(`{"cwd":` + quote(cwd) + `}`) }
	t.Run("hook in the starting project", func(t *testing.T) {
		f := newGuardFixture(t)
		f.local(t, stop)
		if !deferToSettings("stop", input(f.env.projectDir), f.env) {
			t.Fatal("the starting project's registration covers a hook run there")
		}
	})
	t.Run("hook after a move to another directory", func(t *testing.T) {
		f := newGuardFixture(t)
		f.local(t, stop)
		f.write(t, filepath.Join(f.env.projectDir, ".claude", "settings.json"), stop)
		if deferToSettings("stop", input(t.TempDir()), f.env) {
			t.Fatal("a registration in the starting project must not cover a hook run elsewhere")
		}
	})
	t.Run("an input without cwd counts no project file", func(t *testing.T) {
		f := newGuardFixture(t)
		f.local(t, stop)
		if deferToSettings("stop", []byte(`{}`), f.env) {
			t.Fatal("without the hook's cwd the active project is unknown")
		}
	})
	t.Run("user settings still count elsewhere", func(t *testing.T) {
		f := newGuardFixture(t)
		f.user(t, stop)
		if !deferToSettings("stop", input(t.TempDir()), f.env) {
			t.Fatal("user settings apply wherever the session is")
		}
	})
	t.Run("the same directory through a symlink", func(t *testing.T) {
		f := newGuardFixture(t)
		f.local(t, stop)
		link := filepath.Join(t.TempDir(), "link")
		if err := os.Symlink(f.env.projectDir, link); err != nil {
			t.Fatal(err)
		}
		if !deferToSettings("stop", input(link), f.env) {
			t.Fatal("a symlink to the starting project is the starting project")
		}
	})
}
