// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// defaultAPIBase is the production API endpoint used when no env override is set.
// Local-dev users must explicitly set THREENGRAM_API_BASE (or legacy
// THREENGRAM_API_URL) to point at localhost.
const defaultAPIBase = "https://api.3ngram.ai"

// apiBaseURL resolves the REST endpoint in priority order:
//  1. THREENGRAM_API_BASE (preferred)
//  2. THREENGRAM_API_URL  (legacy alias)
//  3. defaultAPIBase      (production)
func apiBaseURL() string {
	if u := strings.TrimSpace(os.Getenv("THREENGRAM_API_BASE")); u != "" {
		return u
	}
	if u := strings.TrimSpace(os.Getenv("THREENGRAM_API_URL")); u != "" {
		return u
	}
	return defaultAPIBase
}

// apiKey returns the API key for X-API-Key auth, preferring the env var but
// falling back to a well-known config file so users can manage the secret
// without editing their shell profile.
//
// Lookup order:
//  1. THREENGRAM_API_KEY env var
//  2. $XDG_CONFIG_HOME/3ngram/api-key (trimmed contents)
//  3. ~/.config/3ngram/api-key (trimmed contents)
func apiKey() string {
	if k := strings.TrimSpace(os.Getenv("THREENGRAM_API_KEY")); k != "" {
		return k
	}
	for _, p := range apiKeyFilePaths() {
		if data, err := os.ReadFile(p); err == nil {
			if k := strings.TrimSpace(string(data)); k != "" {
				return k
			}
		}
	}
	return ""
}

func apiKeyFilePaths() []string {
	var paths []string
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		paths = append(paths, filepath.Join(xdg, "3ngram", "api-key"))
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		paths = append(paths, filepath.Join(home, ".config", "3ngram", "api-key"))
	}
	return paths
}

// apiRequest makes an HTTP request to the 3ngram REST API. Returns the response
// body, the status code, and any transport error — the caller decides how to
// interpret each. Auth is the static X-API-Key chain (apps/server/src/middleware/
// api-key.ts): 200 = bound + routed, 401 = missing/unknown/revoked key (uniform),
// 503 = resolver/DB unavailable. Capture is fire-and-forget: every failure path
// exits 0 so the hook never blocks the user's workflow.
func apiRequest(method, path string, body []byte, timeout time.Duration) ([]byte, int, error) {
	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}

	req, err := http.NewRequest(method, apiBaseURL()+path, bodyReader)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if key := apiKey(); key != "" {
		req.Header.Set("X-API-Key", key)
	}

	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	return respBody, resp.StatusCode, err
}
