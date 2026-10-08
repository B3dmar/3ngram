// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
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

// userFiles are the user settings file and, when the project is certain,
// the project's shared and local files.
//
// Claude Code keeps CLAUDE_PROJECT_DIR at the project the session started in,
// while /cd moves where it reads project settings from, and the hook input's
// cwd follows Claude. A hook cwd that is not the starting project therefore
// leaves open which project's files are active (a /cd, a worktree, or just a
// Bash cd), so neither project's files count then, nor when the input names
// no cwd at all.
func (g guardEnv) userFiles(ctx context.Context, hookCwd string) (files, watched []string, known bool) {
	if g.configDir != "" {
		files = append(files, filepath.Join(g.configDir, "settings.json"))
	}
	if g.projectDir != "" && hookCwd != "" && sameDir(hookCwd, g.projectDir) {
		files = append(files,
			filepath.Join(g.projectDir, ".claude", "settings.json"),
			filepath.Join(g.projectDir, ".claude", "settings.local.json"))
		// Started in a subdirectory or a linked worktree, Claude Code reads
		// the local file at the main checkout's root too, above the one in the
		// starting directory, unless the root is the home directory or not
		// the user's. Where the guard can tell it is read, it counts; where it
		// cannot, it can still only block (see watched).
		root, ok := mainCheckoutRoot(ctx, g.projectDir)
		if !ok {
			return nil, nil, false
		}
		if root != "" && !sameDir(root, g.projectDir) {
			local := filepath.Join(root, ".claude", "settings.local.json")
			if readsRootLocal(root) {
				files = append(files, local)
			} else {
				watched = append(watched, local)
			}
		}
	}
	return files, watched, true
}

// gitBudget bounds every git call one guard decision makes, together: the
// precheck hook it may stand down has 2 s in all.
const gitBudget = 300 * time.Millisecond

// mainCheckoutRoot is the root of the main checkout that dir belongs to, or
// "" when dir is in no repository. ok is false when git could not say (git
// missing, refusing the directory, too slow, an unusual layout such as a
// separate git dir or a submodule): the root may hold a local settings file
// the guard cannot see, so nothing counts then.
func mainCheckoutRoot(ctx context.Context, dir string) (root string, ok bool) {
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "--git-common-dir").Output()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 128 && bytes.Contains(exit.Stderr, []byte("not a git repository")) {
			return "", true
		}
		return "", false
	}
	common := strings.TrimSpace(string(out))
	if !filepath.IsAbs(common) {
		common = filepath.Join(dir, common)
	}
	if filepath.Base(common) != ".git" {
		return "", false
	}
	return filepath.Dir(common), true
}

// readsRootLocal reports whether Claude Code reads the repository root's
// local settings file: not when the root is the home directory, and not when
// the root, its .git or its .claude entry belongs to another user.
func readsRootLocal(root string) bool {
	if home, err := os.UserHomeDir(); err != nil || sameDir(home, root) {
		return false
	}
	for _, p := range []string{root, filepath.Join(root, ".git"), filepath.Join(root, ".claude")} {
		info, err := os.Lstat(p)
		if errors.Is(err, fs.ErrNotExist) && p != root {
			continue
		}
		if err != nil {
			return false
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok || int(st.Uid) != os.Getuid() {
			return false
		}
	}
	return true
}

func sameDir(a, b string) bool {
	return canonicalDir(a) == canonicalDir(b)
}

func canonicalDir(dir string) string {
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		return resolved
	}
	return filepath.Clean(dir)
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
			AllowManagedHooksOnly *bool           `json:"allowManagedHooksOnly"`
			PolicyHelper          json.RawMessage `json:"policyHelper"`
		}
		if err != nil || json.Unmarshal(data, &policy) != nil {
			return nil, false, false
		}
		// A policyHelper's output replaces the managed settings for the
		// session, and the guard cannot run it to see what that output says.
		if len(policy.PolicyHelper) > 0 && !bytes.Equal(bytes.TrimSpace(policy.PolicyHelper), []byte("null")) {
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
	var fields map[string]any
	_ = json.Unmarshal(input, &fields)
	instance := ""
	if target.matcherField != "" {
		if v, ok := fields[target.matcherField].(string); ok {
			instance = v
		}
	}
	hookCwd, _ := fields["cwd"].(string)
	docs, hooksOnly, ok := env.managedPolicy()
	if !ok {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), gitBudget)
	defer cancel()
	files := docs
	var watched []string
	if !hooksOnly {
		user, w, known := env.userFiles(ctx, hookCwd)
		if !known {
			return false
		}
		watched = w
		files = append(user, docs...)
	}
	// A settings file Claude Code may read but the guard cannot count can
	// still turn hooks off, or hide whether it does.
	for _, file := range watched {
		s, state := readSettings(file)
		if state == settingsUnreadable || (state == settingsRead && s.DisableAllHooks != nil && *s.DisableAllHooks) {
			return false
		}
	}
	// files run from the lowest precedence to the highest: user, project,
	// local, then managed. A file that exists but cannot be read may set
	// disableAllHooks, so it claims nothing for any file.
	var settings []settingsHooks
	for _, file := range files {
		s, state := readSettings(file)
		switch state {
		case settingsUnreadable:
			return false
		case settingsRead:
			settings = append(settings, s)
		}
	}
	if effectivelyDisabled(settings) || (!hooksOnly && env.uncertainProjectDisables(ctx, hookCwd)) {
		return false
	}
	family := subcommandFamily(sub)
	for _, s := range settings {
		if settingsOwn(s, target, family, instance) {
			return true
		}
	}
	return false
}

// effectivelyDisabled resolves disableAllHooks the way settings precedence
// does: the highest-precedence file that sets it decides, so a project or
// local false re-enables hooks a user true turned off. When it is true, no
// settings hook can be counted on to run.
func effectivelyDisabled(settings []settingsHooks) bool {
	for i := len(settings) - 1; i >= 0; i-- {
		if v := settings[i].DisableAllHooks; v != nil {
			return *v
		}
	}
	return false
}

type settingsState int

const (
	settingsMissing settingsState = iota
	settingsRead
	settingsUnreadable
)

func readSettings(file string) (settingsHooks, settingsState) {
	data, err := os.ReadFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		return settingsHooks{}, settingsMissing
	}
	var s settingsHooks
	if err != nil || json.Unmarshal(data, &s) != nil {
		return settingsHooks{}, settingsUnreadable
	}
	return s, settingsRead
}

// uncertainProjectDisables covers the project files that do not count because
// the hook's directory leaves the active project open: their registrations
// are ignored, but one of them that sets disableAllHooks, or cannot be read,
// could still turn off the user hooks the guard would defer to. The starting
// project and the hook's directory are the candidates checked.
func (g guardEnv) uncertainProjectDisables(ctx context.Context, hookCwd string) bool {
	if g.projectDir != "" && hookCwd != "" && sameDir(hookCwd, g.projectDir) {
		return false
	}
	for _, dir := range []string{g.projectDir, hookCwd} {
		if dir == "" {
			continue
		}
		candidates := []string{filepath.Join(dir, ".claude", "settings.json"), filepath.Join(dir, ".claude", "settings.local.json")}
		root, ok := mainCheckoutRoot(ctx, dir)
		if !ok {
			return true
		}
		if root != "" && !sameDir(root, dir) {
			candidates = append(candidates, filepath.Join(root, ".claude", "settings.local.json"))
		}
		for _, file := range candidates {
			s, state := readSettings(file)
			if state == settingsUnreadable || (state == settingsRead && s.DisableAllHooks != nil && *s.DisableAllHooks) {
				return true
			}
		}
	}
	return false
}

type settingsHooks struct {
	// DisableAllHooks is a pointer: unset is not false. The effective value
	// is the one the highest-precedence file sets (see effectivelyDisabled).
	DisableAllHooks *bool                  `json:"disableAllHooks"`
	Hooks           map[string][]hookGroup `json:"hooks"`
}

type hookGroup struct {
	// Matcher is kept raw: an omitted matcher matches everything, while a
	// null or a non-string one is not a valid matcher at all.
	Matcher json.RawMessage              `json:"matcher"`
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

// plainHandlerFields are the only handler fields a covering settings hook
// may carry, each with the JSON kind its value must have. Every other field
// (`if`, `async`, `asyncRewake`, `shell`, and whatever Claude Code adds next)
// can change when or whether the hook runs, so a handler that sets one claims
// nothing. `once` is honored only in skill frontmatter and ignored in
// settings files, so it changes nothing here. A value of another kind (a null
// timeout, a numeric statusMessage, a string once) is schema-invalid, and
// Claude Code skips the entry, so it claims nothing either.
var plainHandlerFields = map[string]jsonKind{
	"type": jsonString, "command": jsonString, "args": jsonArray,
	"timeout": jsonNumber, "statusMessage": jsonString, "once": jsonBool,
}

type jsonKind int

const (
	jsonInvalid jsonKind = iota
	jsonNull
	jsonString
	jsonNumber
	jsonBool
	jsonArray
	jsonObject
)

func kindOf(raw json.RawMessage) jsonKind {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 {
		return jsonInvalid
	}
	switch t[0] {
	case 'n':
		return jsonNull
	case '"':
		return jsonString
	case 't', 'f':
		return jsonBool
	case '[':
		return jsonArray
	case '{':
		return jsonObject
	default:
		return jsonNumber
	}
}

func plainHandler(raw map[string]json.RawMessage) (hookHandler, bool) {
	for key, value := range raw {
		if want, ok := plainHandlerFields[key]; !ok || kindOf(value) != want {
			return hookHandler{}, false
		}
	}
	// Every exec-form argument is a string; a null or a number in the list is
	// not one Claude Code passes, so the entry does not run.
	if args, ok := raw["args"]; ok {
		var elems []json.RawMessage
		if json.Unmarshal(args, &elems) != nil {
			return hookHandler{}, false
		}
		for _, e := range elems {
			if kindOf(e) != jsonString {
				return hookHandler{}, false
			}
		}
	}
	var h hookHandler
	b, _ := json.Marshal(raw)
	if json.Unmarshal(b, &h) != nil || h.Type != "command" {
		return hookHandler{}, false
	}
	_, h.execForm = raw["args"]
	return h, true
}

func settingsOwn(s settingsHooks, target hookTarget, family, instance string) bool {
	need := requiredTimeout(target, family)
	for _, group := range s.Hooks[target.event] {
		if !matcherCovers(group.Matcher, target, instance) {
			continue
		}
		for _, raw := range group.Hooks {
			h, ok := plainHandler(raw)
			if !ok {
				continue
			}
			timeout := h.Timeout
			if timeout == nil && target.event == "SessionEnd" {
				// SessionEnd gives a hook without its own timeout the session's
				// short end budget, not the usual default.
				d := sessionEndDefaultTimeout()
				timeout = &d
			}
			if timeout != nil && *timeout < need {
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
func matcherCovers(raw json.RawMessage, target hookTarget, instance string) bool {
	var m string
	// null, a number, a list: not a matcher Claude Code accepts, so the group
	// may not run at all, for any event. (Decoding null into a string is no
	// error, hence the explicit check.)
	if len(raw) > 0 && (bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &m) != nil) {
		return false
	}
	if target.matcherField == "" || len(raw) == 0 {
		return true
	}
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
		// that does not exist. Claude Code substitutes path placeholders
		// first; a settings hook can name ${CLAUDE_PROJECT_DIR}.
		for _, w := range append([]string{h.Command}, h.Args...) {
			words = append(words, expandProjectDir(w))
		}
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

// sessionEndDefaultTimeout is the timeout, in seconds, Claude Code gives a
// SessionEnd hook that sets none: 1.5 s, or what
// CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS sets.
func sessionEndDefaultTimeout() float64 {
	if ms, err := strconv.Atoi(strings.TrimSpace(os.Getenv("CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS"))); err == nil && ms > 0 {
		return float64(ms) / 1000
	}
	return 1.5
}

// expandProjectDir substitutes ${CLAUDE_PROJECT_DIR} the way Claude Code does
// for a settings hook. Without the variable it is left as written, so the
// program does not resolve and the handler claims nothing.
func expandProjectDir(word string) string {
	dir := os.Getenv("CLAUDE_PROJECT_DIR")
	if dir == "" {
		return word
	}
	return strings.ReplaceAll(word, "${CLAUDE_PROJECT_DIR}", dir)
}
