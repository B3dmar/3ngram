// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// The deferral guard for hooks the Claude Code plugin registers. Claude Code
// runs every matching hook of an event, and it never de-duplicates a plugin's
// hook against a settings hook, so a user who already registers the 3ngram
// hooks in settings.json and then installs the plugin would get every briefing,
// heartbeat and close twice. The plugin's copies therefore run as
//
//	3ngram-hook <subcommand> --via plugin
//
// and stand down, for ONE invocation, exactly when a settings file already
// registers that subcommand for that event instance: the same event, a matcher
// that matches this instance (SessionStart's source, PreToolUse's tool name,
// SessionEnd's reason; Stop has no matcher), and an unambiguous 3ngram-hook
// command of the same subcommand family. Anything the guard cannot read with
// certainty (a shell-wrapped command, a regex RE2 cannot compile, an unreadable
// settings file, a missing matcher value) claims nothing, so the plugin copy
// runs: a duplicate run is the failure mode the hooks already survive, a
// missed run is not.

// maxHookInput bounds the stdin the guard buffers. A hook's input is a small
// JSON object; the bound only keeps a misbehaving caller from growing it
// without limit.
const maxHookInput = 4 << 20

type hookTarget struct {
	event        string
	matcherField string
}

var guardedSubcommands = map[string]hookTarget{
	"briefing":  {event: "SessionStart", matcherField: "source"},
	"stop":      {event: "Stop"},
	"heartbeat": {event: "Stop"},
	"close":     {event: "SessionEnd", matcherField: "reason"},
	"precheck":  {event: "PreToolUse", matcherField: "tool_name"},
}

// subcommandFamily folds the documented alias: stop and heartbeat are one
// Stop subcommand.
func subcommandFamily(sub string) string {
	if sub == "heartbeat" {
		return "stop"
	}
	return sub
}

// guardEnv is where settings live, injected for tests.
type guardEnv struct {
	configDir  string // $CLAUDE_CONFIG_DIR, or ~/.claude
	projectDir string // $CLAUDE_PROJECT_DIR, or the cwd's git root, or the cwd
	managed    []string
}

func currentGuardEnv() guardEnv {
	env := guardEnv{configDir: strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR"))}
	if env.configDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			env.configDir = filepath.Join(home, ".claude")
		}
	}
	env.projectDir = strings.TrimSpace(os.Getenv("CLAUDE_PROJECT_DIR"))
	if env.projectDir == "" {
		cwd, _ := os.Getwd()
		if root := gitWorktreeRoot(cwd); root != "" {
			env.projectDir = root
		} else {
			env.projectDir = cwd
		}
	}
	switch runtime.GOOS {
	case "darwin":
		env.managed = []string{"/Library/Application Support/ClaudeCode/managed-settings.json"}
	case "linux":
		env.managed = []string{"/etc/claude-code/managed-settings.json"}
	}
	return env
}

func (g guardEnv) settingsFiles() []string {
	var files []string
	if g.configDir != "" {
		files = append(files, filepath.Join(g.configDir, "settings.json"))
	}
	if g.projectDir != "" {
		files = append(files,
			filepath.Join(g.projectDir, ".claude", "settings.json"),
			filepath.Join(g.projectDir, ".claude", "settings.local.json"))
	}
	return append(files, g.managed...)
}

// viaPlugin reports whether args carry the plugin's `--via plugin` marker,
// and returns the args without it.
func viaPlugin(args []string) (bool, []string) {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--via" && args[i+1] == "plugin" {
			rest := append(append([]string{}, args[:i]...), args[i+2:]...)
			return true, rest
		}
	}
	return false, args
}

// deferToSettings decides one plugin invocation: true when a settings file
// already runs this subcommand for this event instance.
func deferToSettings(sub string, input []byte, env guardEnv) bool {
	target, ok := guardedSubcommands[sub]
	if !ok {
		return false
	}
	instance := ""
	if target.matcherField != "" {
		var fields map[string]any
		if json.Unmarshal(input, &fields) == nil {
			if v, ok := fields[target.matcherField].(string); ok {
				instance = v
			}
		}
	}
	for _, file := range env.settingsFiles() {
		if fileOwns(file, target, subcommandFamily(sub), instance) {
			return true
		}
	}
	return false
}

type settingsHooks struct {
	DisableAllHooks bool                   `json:"disableAllHooks"`
	Hooks           map[string][]hookGroup `json:"hooks"`
}

type hookGroup struct {
	Matcher *string       `json:"matcher"`
	Hooks   []hookHandler `json:"hooks"`
}

type hookHandler struct {
	Type    string   `json:"type"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

func fileOwns(file string, target hookTarget, family, instance string) bool {
	data, err := os.ReadFile(file)
	if err != nil {
		return false
	}
	var s settingsHooks
	if json.Unmarshal(data, &s) != nil || s.DisableAllHooks {
		return false
	}
	for _, group := range s.Hooks[target.event] {
		if !matcherCovers(group.Matcher, target, instance) {
			continue
		}
		for _, h := range group.Hooks {
			if sub, ok := hookSubcommand(h); ok && subcommandFamily(sub) == family {
				return true
			}
		}
	}
	return false
}

// exactMatcher is Claude Code's rule for a matcher compared as plain text: only
// letters, digits, `_`, `-`, spaces, `,` and `|`; anything else is a regex.
var exactMatcher = regexp.MustCompile(`^[A-Za-z0-9_\- ,|]*$`)

// matcherCovers reports whether a group's matcher selects this instance, by
// Claude Code's semantics: absent, empty or `*` matches all; a plain-text
// matcher is a `|` or `,` list compared exactly; anything else is an unanchored
// regex. An event without matcher support ignores the matcher.
func matcherCovers(matcher *string, target hookTarget, instance string) bool {
	if target.matcherField == "" || matcher == nil {
		return true
	}
	m := strings.TrimSpace(*matcher)
	if m == "" || m == "*" {
		return true
	}
	if instance == "" {
		return false
	}
	if exactMatcher.MatchString(m) {
		for _, alt := range strings.FieldsFunc(m, func(r rune) bool { return r == '|' || r == ',' }) {
			if strings.TrimSpace(alt) == instance {
				return true
			}
		}
		return false
	}
	re, err := regexp.Compile(m)
	if err != nil {
		return false
	}
	return re.MatchString(instance)
}

// shellMeta is any character that makes a command more than one plain program
// invocation: a pipe, a list, a substitution, a redirect, a quote, an
// expansion, an assignment.
const shellMeta = ";&|`$()<>\"'\\*?[]{}=~!#\n"

// hookSubcommand reads a handler as a plain `3ngram-hook <subcommand> ...`
// invocation, in exec form (command plus args) or as a shell command without
// any shell syntax. ok is false for anything else.
func hookSubcommand(h hookHandler) (string, bool) {
	if h.Type != "" && h.Type != "command" {
		return "", false
	}
	var words []string
	if len(h.Args) > 0 {
		words = append([]string{h.Command}, h.Args...)
	} else {
		if strings.ContainsAny(h.Command, shellMeta) {
			return "", false
		}
		words = strings.Fields(h.Command)
	}
	if len(words) < 2 || filepath.Base(words[0]) != "3ngram-hook" {
		return "", false
	}
	for _, w := range words[2:] {
		if w == "--via" {
			return "", false
		}
	}
	return words[1], true
}

// replayStdin gives the subcommand the input the guard already read.
func replayStdin(input []byte) {
	r, w, err := os.Pipe()
	if err != nil {
		return
	}
	go func() {
		_, _ = w.Write(input)
		_ = w.Close()
	}()
	os.Stdin = r
}

func readHookInput(r io.Reader) []byte {
	data, _ := io.ReadAll(io.LimitReader(r, maxHookInput))
	return data
}
