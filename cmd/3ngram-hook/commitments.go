// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// `3ngram-hook commitments` is the read-only data path behind the Claude Code
// commitment panel (#255). It is NOT a hook: it is called by the plugin, prints
// exactly one JSON envelope on stdout, and exits non-zero on failure so the
// caller can tell a failed read from an empty one.
//
//	3ngram-hook commitments context [--cwd DIR] [--scope S] [--include-unscoped]
//	3ngram-hook commitments list    [--cwd DIR] [--scope S] [--include-unscoped]
//	3ngram-hook commitments show <memoryId> [--expect-fingerprint F] [selector flags]
//
// `context` makes NO network call. It reports the backend, credential
// fingerprint and selector a `list` would read under, which is how the plugin
// verifies whether rows it already holds still belong to the current context
// after a read failed without an envelope (a process timeout, a missing
// binary, a crash).

const commitmentsContract = "3ngram-hook.commitments.v1"

// commitmentsDeadline is the ONE deadline an operation gets. Every HTTP read an
// operation makes shares it, so the plugin's process ceiling (12 s) always
// outlasts the binary and a slow backend yields a timeout envelope, not a
// killed process. Tests shorten it.
var commitmentsDeadline = 9 * time.Second

// commitmentsOptions is the parsed command line.
type commitmentsOptions struct {
	operation       string
	cwd             string
	scope           string
	includeUnscoped bool
	memoryID        string
	expect          string
}

// commitmentsEnvelope is the whole stdout contract. `context` is present on
// every envelope, errors included, so the plugin can always tell which context
// a failure belongs to.
type commitmentsEnvelope struct {
	Contract    string             `json:"contract"`
	Operation   string             `json:"operation"`
	OK          bool               `json:"ok"`
	Binary      string             `json:"binary"`
	Context     commitmentsContext `json:"context"`
	GeneratedAt string             `json:"generatedAt,omitempty"`
	Counts      *commitmentCounts  `json:"counts,omitempty"`
	// Commitments is a pointer so an ok list always serialises its rows,
	// `[]` included, while envelopes of other operations omit the key.
	Commitments *[]commitmentRow `json:"commitments,omitempty"`
	Partial     []partialPart    `json:"partial,omitempty"`
	Missing     []string         `json:"missing,omitempty"`
	Error       *readError       `json:"error,omitempty"`
	// The `show` operation's parts.
	Commitment *commitmentDetail   `json:"commitment,omitempty"`
	Source     *commitmentSource   `json:"source,omitempty"`
	History    *commitmentHistory  `json:"history,omitempty"`
	Evidence   *commitmentEvidence `json:"evidence,omitempty"`
}

type commitmentsContext struct {
	Fingerprint string            `json:"fingerprint"`
	APIHost     string            `json:"apiHost"`
	Account     *accountInfo      `json:"account,omitempty"`
	Project     projectInfo       `json:"project"`
	Requested   briefingSelector  `json:"requested"`
	Effective   *briefingSelector `json:"effective,omitempty"`
}

type accountInfo struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

type projectInfo struct {
	Name   string `json:"name"`
	Source string `json:"source"`
}

// partialPart labels one part of a response that is incomplete, and why.
// Returned and Total are present exactly when the part is countable, so "0 of
// 25 done" is distinguishable from a part that has no count.
type partialPart struct {
	Part     string `json:"part"`
	Reason   string `json:"reason"`
	Returned *int   `json:"returned,omitempty"`
	Total    *int   `json:"total,omitempty"`
}

// countedPart is a partialPart with a count.
func countedPart(part, reason string, returned, total int) partialPart {
	return partialPart{Part: part, Reason: reason, Returned: &returned, Total: &total}
}

// runCommitments is the process entry: it wires the real stdout/stderr, the
// working directory and a context cancelled by SIGTERM (what the plugin's
// cancel sends) or SIGINT.
func runCommitments(args []string) int {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	cwd, _ := os.Getwd()
	return commitmentsMain(ctx, args, cwd, os.Stdout, stderrWriter)
}

// commitmentsMain is runCommitments with every dependency injected.
func commitmentsMain(ctx context.Context, args []string, cwd string, stdout, stderr io.Writer) int {
	opts, ok := parseCommitmentsFlags(args)
	if opts.cwd == "" {
		opts.cwd = cwd
	}
	env := newCommitmentsEnvelope(opts)
	if !ok {
		return writeEnvelope(stdout, failEnvelope(env, &readError{Kind: kindUsage, Route: "args"}))
	}
	if flagErr := selectorFlagError(opts); flagErr != nil {
		return writeEnvelope(stdout, failEnvelope(env, flagErr))
	}

	switch opts.operation {
	case "context":
		if apiKey() == "" {
			return writeEnvelope(stdout, failEnvelope(env, &readError{Kind: kindNoKey, Route: "config"}))
		}
		if selErr := validateCommitmentsSelector(env.Context); selErr != nil {
			return writeEnvelope(stdout, failEnvelope(env, selErr))
		}
		env.OK = true
		return writeEnvelope(stdout, env)
	case "list":
		deadlineCtx, cancel := context.WithTimeout(ctx, commitmentsDeadline)
		defer cancel()
		return writeEnvelope(stdout, listCommitments(deadlineCtx, env, stderr))
	case "show":
		deadlineCtx, cancel := context.WithTimeout(ctx, commitmentsDeadline)
		defer cancel()
		return writeEnvelope(stdout, showCommitment(deadlineCtx, env, opts.memoryID, opts.expect, stderr))
	default:
		return writeEnvelope(stdout, failEnvelope(env, &readError{Kind: kindUsage, Route: "args"}))
	}
}

// parseCommitmentsFlags reads `<operation> [flags]`. ok is false on any parse
// error or a missing operation; the envelope then reports `usage`.
func parseCommitmentsFlags(args []string) (commitmentsOptions, bool) {
	var opts commitmentsOptions
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return opts, false
	}
	opts.operation = args[0]
	rest := args[1:]
	// `show` takes the memory id first; flags follow it.
	if opts.operation == "show" {
		if len(rest) == 0 || strings.HasPrefix(rest[0], "-") {
			return opts, false
		}
		opts.memoryID, rest = rest[0], rest[1:]
	}

	fs := flag.NewFlagSet("commitments", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&opts.cwd, "cwd", "", "directory the project is derived from")
	fs.StringVar(&opts.scope, "scope", "", "scope to read within (optional)")
	fs.BoolVar(&opts.includeUnscoped, "include-unscoped", false, "also read the scope's records with no project")
	// --json is accepted for readability at call sites; output is always JSON.
	fs.Bool("json", true, "emit JSON (always on)")
	if opts.operation == "show" {
		fs.StringVar(&opts.expect, "expect-fingerprint", "", "refuse unless the current context has this fingerprint")
	}
	if err := fs.Parse(rest); err != nil || fs.NArg() != 0 {
		return opts, false
	}
	opts.scope = strings.TrimSpace(opts.scope)
	return opts, true
}

// selectorFlagError is the one flag combination that parses but must not run:
// unscoped records exist only within a scope, so asking for them without one
// would either read nothing or tempt a silent widening.
func selectorFlagError(opts commitmentsOptions) *readError {
	if opts.includeUnscoped && opts.scope == "" {
		return &readError{Kind: kindInvalidSelector, Route: "selector", Hint: "--include-unscoped requires --scope"}
	}
	return nil
}

// requestedSelector derives the selector a read asks for. The project comes
// from the same rule the SessionStart hook uses; a scope narrows it to the
// scope_project intersection, the only variant that can include unscoped
// records, and only when asked.
func requestedSelector(opts commitmentsOptions) (briefingSelector, projectInfo) {
	name, source := deriveProjectWithSource(opts.cwd)
	project := projectInfo{Name: name, Source: source}
	if opts.scope == "" {
		return briefingSelector{Kind: "project", Project: name}, project
	}
	include := opts.includeUnscoped
	return briefingSelector{Kind: "scope_project", Scope: opts.scope, Project: name, IncludeUnscoped: &include}, project
}

// validateCommitmentsSelector rejects the combinations that would otherwise
// widen silently or read nothing meaningful. It runs before any request.
func validateCommitmentsSelector(c commitmentsContext) *readError {
	if c.Project.Source == projectSourceNone || c.Project.Name == "" {
		return &readError{Kind: kindInvalidSelector, Route: "selector", Hint: "no project could be derived"}
	}
	return nil
}

// newCommitmentsEnvelope stamps the context every envelope carries. It reads
// configuration only, never the network.
func newCommitmentsEnvelope(opts commitmentsOptions) commitmentsEnvelope {
	base := apiBaseURL()
	sel, project := requestedSelector(opts)
	return commitmentsEnvelope{
		Contract:  commitmentsContract,
		Operation: opts.operation,
		Binary:    "3ngram-hook " + version,
		Context: commitmentsContext{
			Fingerprint: contextFingerprint(base, apiKey(), sel),
			APIHost:     apiHost(base),
			Project:     project,
			Requested:   sel,
		},
	}
}

func failEnvelope(env commitmentsEnvelope, e *readError) commitmentsEnvelope {
	env.OK = false
	env.Error = e
	env.Commitments = nil
	env.Counts = nil
	env.Commitment, env.Source, env.History, env.Evidence = nil, nil, nil, nil
	env.Partial = nil
	return env
}

// writeEnvelope prints the envelope and returns the exit code: 0 for ok
// (partial results included), 1 for a local problem the user fixes in config or
// flags, 2 for anything that happened on the way to or at the backend.
func writeEnvelope(stdout io.Writer, env commitmentsEnvelope) int {
	enc := json.NewEncoder(stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(env); err != nil {
		return 2
	}
	return exitCodeFor(env)
}

func exitCodeFor(env commitmentsEnvelope) int {
	if env.OK {
		return 0
	}
	if env.Error != nil {
		switch env.Error.Kind {
		case kindUsage, kindNoKey, kindInvalidSelector, kindContextChanged:
			return 1
		}
	}
	return 2
}
