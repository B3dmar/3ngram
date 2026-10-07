// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
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
// SessionEnd's reason; Stop has no matcher), and a plain, runnable 3ngram-hook
// command of the same subcommand family. Anything the guard cannot read with
// certainty claims nothing, so the plugin copy runs: a duplicate run is the
// failure mode the hooks already survive, a missed run is not.

// maxHookInput bounds the stdin the guard reads to decide. A hook's input is
// a small JSON object; a larger one (a Write of a big file) is passed through
// whole, and the guard claims nothing for it.
const maxHookInput = 4 << 20

type hookTarget struct {
	event        string
	matcherField string
	// timeout is the plugin copy's own timeout in seconds (hooks.json). A
	// settings copy given less time may be killed before it finishes, so it
	// does not count as covering the event.
	timeout float64
}

var guardedSubcommands = map[string]hookTarget{
	"briefing":  {event: "SessionStart", matcherField: "source", timeout: 10},
	"stop":      {event: "Stop", timeout: 10},
	"heartbeat": {event: "Stop", timeout: 10},
	"close":     {event: "SessionEnd", matcherField: "reason", timeout: 5},
	"precheck":  {event: "PreToolUse", matcherField: "tool_name", timeout: 2},
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
	Matcher *string                      `json:"matcher"`
	Hooks   []map[string]json.RawMessage `json:"hooks"`
}

type hookHandler struct {
	Type    string   `json:"type"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Timeout *float64 `json:"timeout"`
}

// plainHandlerKeys are the only handler fields a covering settings hook may
// carry. Every other field (`if`, `async`, `asyncRewake`, `once`, `shell`, and
// whatever Claude Code adds next) can change when or whether the hook runs,
// so a handler that sets one claims nothing.
var plainHandlerKeys = map[string]bool{"type": true, "command": true, "args": true, "timeout": true, "statusMessage": true}

func plainHandler(raw map[string]json.RawMessage) (hookHandler, bool) {
	for key := range raw {
		if !plainHandlerKeys[key] {
			return hookHandler{}, false
		}
	}
	var h hookHandler
	b, _ := json.Marshal(raw)
	if json.Unmarshal(b, &h) != nil || h.Type != "command" {
		return hookHandler{}, false
	}
	return h, true
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
		for _, raw := range group.Hooks {
			h, ok := plainHandler(raw)
			if !ok || (h.Timeout != nil && *h.Timeout < target.timeout) {
				continue
			}
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

// portableRegex is the regex subset JavaScript and Go RE2 read the same way:
// literals, `.`, anchors, alternation, groups, classes and the `* + ?`
// quantifiers. Inline flags such as `(?i)`, escapes (`\A`, `\d`, `\p{..}`),
// POSIX classes and brace quantifiers fall outside it and claim nothing: a
// matcher Go accepts but JavaScript reads differently would defer an event the
// settings hook never runs for.
var portableRegex = regexp.MustCompile(`^[A-Za-z0-9_\-.^$|()*+?\[\]]+$`)

// matcherCovers reports whether a group's matcher selects this instance, by
// Claude Code's semantics: absent, empty or `*` matches all; a plain-text
// matcher is a `|` or `,` list compared exactly; anything else is an unanchored
// regex. An event without matcher support ignores the matcher.
func matcherCovers(matcher *string, target hookTarget, instance string) bool {
	if target.matcherField == "" || matcher == nil {
		return true
	}
	m := *matcher
	if m == "" || m == "*" {
		return true
	}
	// A space anywhere leaves open whether Claude Code trims alternatives
	// ("Edit | Write"), so such a matcher claims nothing.
	if instance == "" || strings.Contains(m, " ") {
		return false
	}
	if exactMatcher.MatchString(m) {
		for _, alt := range strings.FieldsFunc(m, func(r rune) bool { return r == '|' || r == ',' }) {
			if alt == instance {
				return true
			}
		}
		return false
	}
	if !portableRegex.MatchString(m) || strings.Contains(m, "(?") {
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
// any shell syntax, whose program would actually start. ok is false for
// anything else.
func hookSubcommand(h hookHandler) (string, bool) {
	var words []string
	if len(h.Args) > 0 {
		words = append([]string{h.Command}, h.Args...)
	} else {
		if strings.ContainsAny(h.Command, shellMeta) {
			return "", false
		}
		words = strings.Fields(h.Command)
	}
	if len(words) < 2 || filepath.Base(words[0]) != "3ngram-hook" || !runnable(words[0]) {
		return "", false
	}
	for _, w := range words[2:] {
		if w == "--via" {
			return "", false
		}
	}
	return words[1], true
}

// runnable reports whether a settings command would start: a path that is an
// executable file, or a bare name found on PATH (the hook's PATH is this
// process's, both being children of the same Claude Code). A registration left
// pointing at a moved binary must not stand the plugin copy down.
func runnable(program string) bool {
	if strings.Contains(program, "/") {
		info, err := os.Stat(program)
		return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
	}
	_, err := exec.LookPath(program)
	return err == nil
}

// readHookInput buffers the hook's stdin for the guard. complete is false
// when the input is larger than maxHookInput: then the guard claims nothing,
// and the subcommand still receives every byte (see replayStdin).
func readHookInput(r io.Reader) (prefix []byte, complete bool) {
	data, _ := io.ReadAll(io.LimitReader(r, maxHookInput+1))
	return data, len(data) <= maxHookInput
}

// replayStdin gives the subcommand the input the guard already read, followed
// by whatever it did not read.
func replayStdin(prefix []byte, rest io.Reader) {
	r, w, err := os.Pipe()
	if err != nil {
		return
	}
	go func() {
		_, _ = w.Write(prefix)
		_, _ = io.Copy(w, rest)
		_ = w.Close()
	}()
	os.Stdin = r
}
