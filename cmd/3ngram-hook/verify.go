// SPDX-License-Identifier: Apache-2.0
package main

import (
	"fmt"
	"os"
	"time"
)

// runVerify prints the resolved API base + key presence and probes the
// authenticated GET /api/v1/briefing?kind=all endpoint (the X-API-Key chain,
// apps/server/src/middleware/api-key.ts). Exit codes:
//
//	0  fully wired: key present and the server accepted it (HTTP 200)
//	1  config missing: no API key resolved
//	2  unreachable / rejected: transport error, 401 (bad key), 503, or other 4xx/5xx
func runVerify() int {
	base := apiBaseURL()
	key := apiKey()

	fmt.Fprintf(os.Stdout, "3ngram-hook verify\n")
	fmt.Fprintf(os.Stdout, "  API base: %s\n", base)
	if key == "" {
		fmt.Fprintf(os.Stdout, "  API key:  <missing>\n")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "No API key configured.")
		fmt.Fprintln(os.Stderr, "  1. Create one at https://app.3ngram.ai/settings/api-keys")
		fmt.Fprintln(os.Stderr, "  2. export THREENGRAM_API_KEY=3ng_... (or write it to ~/.config/3ngram/api-key)")
		fmt.Fprintln(os.Stderr, "  3. Re-run `3ngram-hook verify`")
		return 1
	}

	prefix := key
	if len(prefix) > 8 {
		prefix = prefix[:8]
	}
	fmt.Fprintf(os.Stdout, "  API key:  %s… (%d chars)\n", prefix, len(key))

	body, status, err := apiRequest("GET", "/api/v1/briefing?kind=all", nil, 5*time.Second)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  briefing: unreachable (%v)\n", err)
		return 2
	}
	fmt.Fprintf(os.Stdout, "  briefing: %d\n", status)
	switch {
	case status == 401:
		fmt.Fprintln(os.Stderr, "  API key rejected (401). Check the key value and that it is active.")
		return 2
	case status == 503:
		fmt.Fprintln(os.Stderr, "  service unavailable (503). The resolver/DB is down; retry shortly.")
		return 2
	case status >= 400:
		fmt.Fprintf(os.Stderr, "  body: %s\n", string(body))
		return 2
	}
	fmt.Fprintln(os.Stdout, "OK — briefing pipeline is configured.")
	return 0
}
