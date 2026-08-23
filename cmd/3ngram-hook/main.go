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
		fmt.Fprintln(os.Stderr, "usage: 3ngram-hook <briefing|heartbeat|close|precheck|sync|verify|version> [--agent <name>]")
		os.Exit(1)
	}

	// Subcommand arguments (today only `--agent <name>`, the harness name for the
	// session natural key) are passed through rather than parsed here, so a hook
	// registration names the harness that will run it.
	args := os.Args[2:]

	switch os.Args[1] {
	case "briefing":
		os.Exit(runBriefing(args))
	case "heartbeat":
		os.Exit(runHeartbeat(args))
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
