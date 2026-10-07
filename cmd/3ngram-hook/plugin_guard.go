// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
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
	// need is how long, in seconds, the subcommand can take to finish: its
	// own request deadlines plus a margin. A settings copy given less time may
	// be killed first, so it does not count as covering the event.
	need float64
}

var guardedSubcommands = map[string]hookTarget{
	// The 5 s briefing read, then up to 5 s to probe and open the session
	// (after /clear with no row: a 2 s probe, then a 3 s open). 10 s is that
	// worst case exactly, and what the documented registration gives.
	"briefing": {event: "SessionStart", matcherField: "source", need: 10},
	// The 2 s heartbeat; requiredTimeout raises it when the nudge is armed.
	"stop":      {event: "Stop", need: 3},
	"heartbeat": {event: "Stop", need: 3},
	// The 1 s close.
	"close": {event: "SessionEnd", matcherField: "reason", need: 2},
	// The 500 ms search.
	"precheck": {event: "PreToolUse", matcherField: "tool_name", need: 2},
}

// requiredTimeout is the least per-hook timeout that lets a settings copy of
// family finish its work. With THREENGRAM_STOP_NUDGE=1 the Stop path makes
// three more 2 s calls after the heartbeat, which is why the documented nudge
// registration gives Stop 10 s; without it the documented 5 s covers Stop.
func requiredTimeout(target hookTarget, family string) float64 {
	if family == "stop" && stopNudgeEnabled() {
		return 10
	}
	return target.need
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
	// managedDir is the system directory holding managed-settings.json and
	// the managed-settings.d/ drop-ins.
	managedDir string
	// opaqueAdmin are admin sources the guard cannot read (a macOS managed
	// preferences profile): one that exists may set any policy.
	opaqueAdmin []string
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
		env.managedDir = "/Library/Application Support/ClaudeCode"
		const profile = "com.anthropic.claudecode.plist"
		env.opaqueAdmin = []string{filepath.Join("/Library/Managed Preferences", profile)}
		if name := os.Getenv("USER"); name != "" && !strings.ContainsRune(name, '/') {
			env.opaqueAdmin = append(env.opaqueAdmin, filepath.Join("/Library/Managed Preferences", name, profile))
		}
	case "linux":
		env.managedDir = "/etc/claude-code"
	}
	return env
}

// userFiles are the user, project and local settings files.
func (g guardEnv) userFiles() []string {
	var files []string
	if g.configDir != "" {
		files = append(files, filepath.Join(g.configDir, "settings.json"))
	}
	if g.projectDir != "" {
		files = append(files,
			filepath.Join(g.projectDir, ".claude", "settings.json"),
			filepath.Join(g.projectDir, ".claude", "settings.local.json"))
	}
	return files
}

// managedPolicy reads the admin sources the guard can see. docs are the
// managed settings files, in the order Claude Code merges them. hooksOnly is
// whether one of them sets allowManagedHooksOnly, which blocks user, project
// and local hooks but exempts a plugin that policy force-enables (which is how
// this copy can be running at all), so only managed hooks can cover an event.
//
// ok is false when an admin source is present that the guard cannot evaluate:
// a managed preferences profile, a server-managed settings cache that holds a
// policy, or a managed file it cannot read. Any of them may block the settings
// hooks or outrank the files, so nothing counts as coverage then.
func (g guardEnv) managedPolicy() (docs []string, hooksOnly, ok bool) {
	for _, profile := range g.opaqueAdmin {
		if _, err := os.Stat(profile); !errors.Is(err, fs.ErrNotExist) {
			return nil, false, false
		}
	}
	if g.configDir != "" && remotePolicyPresent(filepath.Join(g.configDir, "remote-settings.json")) {
		return nil, false, false
	}
	if g.managedDir == "" {
		return nil, false, true
	}
	candidates := []string{filepath.Join(g.managedDir, "managed-settings.json")}
	dropIns := filepath.Join(g.managedDir, "managed-settings.d")
	entries, err := os.ReadDir(dropIns)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, false, false
	}
	// ReadDir sorts by name, the order Claude Code merges drop-ins in; it
	// ignores hidden files.
	for _, e := range entries {
		if name := e.Name(); !e.IsDir() && !strings.HasPrefix(name, ".") && strings.HasSuffix(name, ".json") {
			candidates = append(candidates, filepath.Join(dropIns, name))
		}
	}
	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		var policy struct {
			AllowManagedHooksOnly *bool `json:"allowManagedHooksOnly"`
		}
		if err != nil || json.Unmarshal(data, &policy) != nil {
			return nil, false, false
		}
		// Any file setting it counts, whatever a later drop-in says: reading
		// the lock where there is none costs a duplicate run, missing one
		// costs the hook.
		if policy.AllowManagedHooksOnly != nil && *policy.AllowManagedHooksOnly {
			hooksOnly = true
		}
		docs = append(docs, path)
	}
	return docs, hooksOnly, true
}

// remotePolicyPresent reports whether the server-managed settings cache holds
// a policy. An empty cache is none; one the guard cannot read counts as one.
func remotePolicyPresent(path string) bool {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false
	}
	var doc map[string]json.RawMessage
	if err != nil || json.Unmarshal(data, &doc) != nil {
		return true
	}
	return len(doc) > 0
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
	docs, hooksOnly, ok := env.managedPolicy()
	if !ok {
		return false
	}
	files := docs
	if !hooksOnly {
		files = append(env.userFiles(), docs...)
	}
	family := subcommandFamily(sub)
	for _, file := range files {
		if fileOwns(file, target, family, instance) {
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
	// execForm is whether the handler has an args field at all: Claude Code
	// selects exec form by its presence, an empty list included.
	execForm bool
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
	if args, ok := raw["args"]; ok {
		// A null leaves open which form Claude Code picks, so it claims nothing.
		if bytes.Equal(bytes.TrimSpace(args), []byte("null")) {
			return hookHandler{}, false
		}
		h.execForm = true
	}
	return h, true
}

func fileOwns(file string, target hookTarget, family, instance string) bool {
	need := requiredTimeout(target, family)
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
			if !ok || (h.Timeout != nil && *h.Timeout < need) {
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
// matcher is a `|` or `,` list compared exactly, each alternative trimmed of
// surrounding whitespace ("Edit | Write"); anything else is an unanchored
// regex. An event without matcher support ignores the matcher.
func matcherCovers(matcher *string, target hookTarget, instance string) bool {
	if target.matcherField == "" || matcher == nil {
		return true
	}
	m := *matcher
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
	if h.execForm {
		// No shell: command is the program itself and is never split, so
		// `"command": "3ngram-hook briefing", "args": []` names a program
		// that does not exist.
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
