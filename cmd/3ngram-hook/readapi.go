// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// The read-only client behind `3ngram-hook commitments`. It is deliberately a
// SEPARATE path from apiRequest: apiRequest takes any method and is what the
// lifecycle hooks write through, while everything a commitments subcommand sends
// goes through apiGet, which can only GET. The "zero panel-initiated writes"
// guarantee of #255 rests on that split, and TestCommitmentsDataPathIsReadOnly
// in readapi_test.go pins it.

// maxReadBody bounds one response body. The largest read here is a 100-item
// briefing slice or a memory with its 10k-character content, both far below it;
// the bound exists so a misbehaving server cannot make the panel's subprocess
// buffer without limit.
const maxReadBody = 8 << 20

// readError is a classified read failure: a stable `kind` the plugin branches
// on, the route it happened on, and the HTTP status when there was one. It never
// carries a response body, because bodies can echo memory content (AGENTS.md
// hard rule 6).
type readError struct {
	Kind   string `json:"kind"`
	Route  string `json:"route,omitempty"`
	Status int    `json:"status,omitempty"`
	Hint   string `json:"hint,omitempty"`
}

func (e *readError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("%s: %s (%d)", e.Route, e.Kind, e.Status)
	}
	return fmt.Sprintf("%s: %s", e.Route, e.Kind)
}

// Error kinds. Local kinds exit 1, everything else exits 2 (see exitCodeFor).
const (
	kindUsage            = "usage"
	kindNoKey            = "no_key"
	kindInvalidSelector  = "invalid_selector"
	kindAuth             = "auth"
	kindUnavailable      = "unavailable"
	kindTimeout          = "timeout"
	kindCancelled        = "cancelled"
	kindRateLimited      = "rate_limited"
	kindNotFound         = "not_found"
	kindRouteMissing     = "route_missing"
	kindBadRequest       = "bad_request"
	kindBadResponse      = "bad_response"
	kindSelectorMismatch = "selector_mismatch"
)

// readConfig is the backend and credential one operation reads with. It is
// resolved ONCE per operation and passed to every read, so a key file rotated
// mid-operation can never make two reads of one envelope authenticate as
// different accounts, and the fingerprint describes exactly the credential the
// reads used.
type readConfig struct {
	base string
	key  string
}

func resolveReadConfig() readConfig {
	return readConfig{base: apiBaseURL(), key: apiKey()}
}

// resolveReadConfigCtx is resolveReadConfig under the operation's deadline:
// reading the key file can block on a stalled filesystem, and the envelope
// must still be written in time. ok is false when ctx ended first.
func resolveReadConfigCtx(ctx context.Context) (readConfig, bool) {
	done := make(chan readConfig, 1)
	go func() { done <- resolveReadConfig() }()
	select {
	case cfg := <-done:
		return cfg, true
	case <-ctx.Done():
		return readConfig{base: apiBaseURL()}, false
	}
}

// jsonNullable is a JSON field that must be present but may be null. It
// records whether the key was there at all, so an omitted field is never
// mistaken for an explicit null (a null project means "unscoped").
type jsonNullable struct {
	Present bool
	Value   *string
}

func (n *jsonNullable) UnmarshalJSON(b []byte) error {
	n.Present = true
	if string(b) == "null" {
		n.Value = nil
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	n.Value = &s
	return nil
}

func (n jsonNullable) MarshalJSON() ([]byte, error) {
	if n.Value == nil {
		return []byte("null"), nil
	}
	return json.Marshal(*n.Value)
}

// apiGet performs one GET against the 3ngram REST API under ctx, which carries
// the operation's single deadline, and decodes a 2xx JSON body into out. The
// method is not a parameter: this function cannot send anything but GET.
func apiGet(ctx context.Context, cfg readConfig, route, path string, out any) *readError {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.base+path, nil)
	if err != nil {
		return &readError{Kind: kindBadRequest, Route: route}
	}
	req.Header.Set("Accept", "application/json")
	if cfg.key != "" {
		req.Header.Set("X-API-Key", cfg.key)
	}

	resp, err := readClient.Do(req)
	if err != nil {
		return classifyReadFailure(ctx, route, 0, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxReadBody+1))
	if err != nil {
		return classifyReadFailure(ctx, route, resp.StatusCode, err)
	}
	if len(body) > maxReadBody {
		return &readError{Kind: kindBadResponse, Route: route, Status: resp.StatusCode, Hint: "response body too large"}
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return classifyReadFailure(ctx, route, resp.StatusCode, nil)
	}
	if err := json.Unmarshal(body, out); err != nil {
		return &readError{Kind: kindBadResponse, Route: route, Status: resp.StatusCode}
	}
	return nil
}

// classifyReadFailure maps a transport error or a non-2xx status to a kind. A
// context error wins over the transport error it caused, so an expired deadline
// reads as `timeout` and a signal as `cancelled`, never as `unavailable`.
func classifyReadFailure(ctx context.Context, route string, status int, err error) *readError {
	if ctxErr := ctx.Err(); ctxErr != nil {
		if errors.Is(ctxErr, context.DeadlineExceeded) {
			return &readError{Kind: kindTimeout, Route: route}
		}
		return &readError{Kind: kindCancelled, Route: route}
	}
	if err != nil && status == 0 {
		var urlErr *url.Error
		if errors.As(err, &urlErr) && urlErr.Timeout() {
			return &readError{Kind: kindTimeout, Route: route}
		}
		return &readError{Kind: kindUnavailable, Route: route}
	}
	switch {
	case err != nil:
		return &readError{Kind: kindBadResponse, Route: route, Status: status}
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return &readError{Kind: kindAuth, Route: route, Status: status, Hint: "run 3ngram-hook verify"}
	case status == http.StatusNotFound:
		return &readError{Kind: kindNotFound, Route: route, Status: status}
	case status >= 300 && status <= 399:
		return &readError{Kind: kindBadRequest, Route: route, Status: status, Hint: "redirect not followed"}
	case status == http.StatusTooManyRequests:
		return &readError{Kind: kindRateLimited, Route: route, Status: status}
	case status >= 500:
		return &readError{Kind: kindUnavailable, Route: route, Status: status}
	default:
		return &readError{Kind: kindBadRequest, Route: route, Status: status}
	}
}

// logReadFailure writes the one stderr line a failed read leaves: route, kind
// and status only. Never a body, a topic or the key.
func logReadFailure(stderr io.Writer, e *readError) {
	if e == nil || stderr == nil {
		return
	}
	fmt.Fprintf(stderr, "3ngram-hook: commitments %s\n", e.Error())
}

// credentialHash is a one-way identity for the API key, so a fingerprint can
// tell two keys apart without the key, or anything reversible from it, ever
// leaving the process.
func credentialHash(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// contextFingerprint identifies WHAT a response was read under: the backend, the
// credential and the requested selector. The plugin keeps rows only alongside
// the fingerprint that produced them, so a key swap, a backend change or a
// different selector can never show one context's records under another's
// header. It is computed locally, before any request, so error envelopes carry
// it too.
func contextFingerprint(apiBase, key string, sel briefingSelector) string {
	canonical, _ := json.Marshal(struct {
		APIBase    string           `json:"apiBase"`
		Credential string           `json:"credential"`
		Selector   briefingSelector `json:"selector"`
	}{apiBase, credentialHash(key), sel})
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:8])
}

// memoryPath is the only way a data-path file builds a /memories/:id path. It
// is a PATH-SAFETY guard, not an id validator: what a memory id may look like
// is packages/schema's to decide (AGENTS.md hard rule 2), and the server
// answers an id it does not accept with 404. The guard only keeps an id from
// changing which route a keyed GET reaches: the id is escaped as one path
// segment, and the dot segments a client would resolve are refused outright.
func memoryPath(memoryID, suffix string) (string, bool) {
	if memoryID == "" || memoryID == "." || memoryID == ".." {
		return "", false
	}
	return "/api/v1/memories/" + url.PathEscape(memoryID) + suffix, true
}

// apiHost is the backend as the header shows it: the host alone, never a path
// or query that could carry anything else.
func apiHost(apiBase string) string {
	if u, err := url.Parse(apiBase); err == nil && u.Host != "" {
		return u.Host
	}
	// Never the raw value: a malformed base can carry a path, a query or user
	// info, and every envelope prints this field.
	return invalidAPIHost
}

// invalidAPIHost is what the envelope names when the API base has no host.
const invalidAPIHost = "(invalid API base)"

// readClient never follows a redirect. The default client would replay the
// custom X-API-Key header to whatever host a 3xx names; a read that is answered
// with a redirect is a bad request, not a reason to send the key elsewhere. The
// deadline lives on the request's context, so the client sets no timeout.
var readClient = &http.Client{
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}
