// SPDX-License-Identifier: Apache-2.0
package main

import (
	"fmt"
	"os"
)

// version is the release version string. It defaults to "dev" for source
// builds and is overridden at release time via ldflags:
//
//	go build -ldflags="-X main.version=3ngram-hook-v1.2.3" .
//
// See .github/workflows/release-3ngram-hook.yml.
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: 3ngram-hook <briefing|stop|close|precheck|sync|verify|version> [--agent <name>]")
		os.Exit(1)
	}

	// Subcommand arguments (today only `--agent <name>`, the harness name for the
	// session natural key) are passed through rather than parsed here, so a hook
	// registration names the harness that will run it.
	args := os.Args[2:]

	switch os.Args[1] {
	case "briefing":
		os.Exit(runBriefing(args))
	// `heartbeat` is a COMPATIBILITY ALIAS for `stop`, not a second behavior.
	// Every shipped registration names it, and one Stop subcommand that
	// heartbeats always and nudges only behind THREENGRAM_STOP_NUDGE=1 is
	// strictly better than two registered commands racing on an event whose
	// matching hooks launch concurrently (see runStop). An operator who upgrades
	// the binary without editing settings.json keeps exactly the behavior they
	// had, because the nudge is gated by the flag rather than by the name.
	case "stop", "heartbeat":
		os.Exit(runStop(args))
	case "close":
		os.Exit(runClose(args))
	case "precheck":
		os.Exit(runPrecheck())
	case "sync":
		os.Exit(runSync())
	case "verify":
		os.Exit(runVerify())
	case "version", "--version", "-v":
		fmt.Printf("3ngram-hook %s\n", version)
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		os.Exit(1)
	}
}
