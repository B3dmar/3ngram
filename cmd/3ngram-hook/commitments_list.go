// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"io"
	"net/url"
	"strconv"
	"sync"
)

// commitmentRow is one open or waiting commitment as the panel lists it. It
// carries no memory content: a list orients, and `show` is where content is
// read, after its own selector check.
type commitmentRow struct {
	MemoryID     string    `json:"memoryId"`
	CommitmentID string    `json:"commitmentId"`
	Topic        string    `json:"topic"`
	Status       string    `json:"status"`
	DueAt        *string   `json:"dueAt"`
	Overdue      bool      `json:"overdue"`
	Filing       string    `json:"filing"`
	Ownership    ownership `json:"ownership"`
}

// ownership is reported, never inferred. The read routes do not expose
// `commitments.owner` (and native writes never set it), so every row is
// `unclear` with that reason. `waiting` is deliberately NOT read as a
// dependency: that would be lifecycle meaning the store does not record.
type ownership struct {
	Value  string `json:"value"`
	Reason string `json:"reason"`
}

var unclearOwnership = ownership{Value: "unclear", Reason: "owner_not_exposed"}

// Filing labels. `unscoped` is only ever assigned after the memory itself was
// read back with project = null; see fileRows.
const (
	filingProject  = "project"
	filingUnscoped = "unscoped"
	filingUnknown  = "unknown"
)

type commitmentCounts struct {
	// OpenOrWaiting and Overdue are the server's exact counts for the
	// requested selector, which can exceed what one bounded slice returns.
	OpenOrWaiting int `json:"openOrWaiting"`
	Overdue       int `json:"overdue"`
	Returned      int `json:"returned"`
	// ChangedDuringRead counts rows dropped because their memory, read back
	// for filing, was no longer live or no longer inside the selector.
	ChangedDuringRead int `json:"changedDuringRead"`
}

// The bounds of one list read. The filing lookups and their concurrency are
// the panel's own budget, not server limits: 25 reads is a quarter of a slice
// and well inside the per-key rate limit even with precheck running beside it.
const (
	maxFilingLookups = 25
	readConcurrency  = 4
)

type meResponse struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

// memoryFiling is the subset of GET /api/v1/memories/:id the filing check
// reads. Content is in that body too, and is discarded here.
type memoryFiling struct {
	Scope   string  `json:"scope"`
	Project *string `json:"project"`
	Status  string  `json:"status"`
	ValidTo *string `json:"validTo"`
}

// listCommitments reads the selector's open and waiting commitments under the
// operation's single deadline in ctx.
func listCommitments(ctx context.Context, env commitmentsEnvelope, stderr io.Writer) commitmentsEnvelope {
	if apiKey() == "" {
		return failEnvelope(env, &readError{Kind: kindNoKey, Route: "config"})
	}
	if selErr := validateCommitmentsSelector(env.Context); selErr != nil {
		return failEnvelope(env, selErr)
	}
	requested := env.Context.Requested
	widened := requested.IncludeUnscoped != nil && *requested.IncludeUnscoped

	var me meResponse
	var wide, strict briefingResponse
	var meErr, wideErr, strictErr *readError
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); meErr = apiGet(ctx, "me", "/api/v1/me", &me) }()
	go func() {
		defer wg.Done()
		wideErr = apiGet(ctx, "briefing", "/api/v1/briefing"+buildCommitmentsQuery(requested), &wide)
	}()
	if widened {
		wg.Add(1)
		go func() {
			defer wg.Done()
			strictErr = apiGet(ctx, "briefing", "/api/v1/briefing"+buildCommitmentsQuery(strictSelector(requested)), &strict)
		}()
	}
	wg.Wait()

	if wideErr != nil {
		if wideErr.Kind == kindNotFound {
			wideErr.Kind = kindRouteMissing
		}
		logReadFailure(stderr, wideErr)
		return failEnvelope(env, wideErr)
	}
	if !selectorWithin(requested, wide.Selector) {
		mismatch := &readError{Kind: kindSelectorMismatch, Route: "briefing"}
		logReadFailure(stderr, mismatch)
		return failEnvelope(env, mismatch)
	}
	effective := wide.Selector
	env.Context.Effective = &effective

	if meErr == nil {
		env.Context.Account = &accountInfo{ID: me.ID, Email: me.Email}
	} else {
		logReadFailure(stderr, meErr)
		env.Partial = append(env.Partial, partialPart{Part: "account", Reason: meErr.Kind})
	}

	rows := mergeSections(wide.Commitments, wide.Overdue)
	// The strict read decides filing for the rows it returns, so its echo is
	// held to the same rule as the widened one: a strict read that answered
	// under a wider selector proves nothing, and every row is verified instead.
	if widened && strictErr == nil && !selectorWithin(strictSelector(requested), strict.Selector) {
		strictErr = &readError{Kind: kindSelectorMismatch, Route: "briefing"}
	}
	var strictPtr *briefingResponse
	if widened && strictErr == nil {
		strictPtr = &strict
	} else if widened {
		logReadFailure(stderr, strictErr)
		env.Partial = append(env.Partial, partialPart{Part: "filing", Reason: "strict_read_" + strictErr.Kind})
	}
	filed := fileRows(ctx, rows, requested, widened, strictPtr)
	env.Partial = append(env.Partial, filed.partial...)

	env.Counts = &commitmentCounts{
		OpenOrWaiting:     wide.Commitments.Count,
		Overdue:           wide.Overdue.Count,
		Returned:          len(filed.rows),
		ChangedDuringRead: filed.changed,
	}
	env.Partial = append(env.Partial, truncationParts(wide)...)
	env.Commitments = &filed.rows
	env.Missing = []string{"owner", "sourceSession"}
	env.GeneratedAt = wide.GeneratedAt
	env.OK = true
	return env
}

// buildCommitmentsQuery is the briefing GET for the panel: the selector, the
// full mode, only the two commitment sections, and the largest slice the server
// allows, so `hasMore` is the only reason a row can be missing.
func buildCommitmentsQuery(s briefingSelector) string {
	values := url.Values{}
	encodeSelector(values, s)
	values.Set("mode", "full")
	values.Set("sections", "commitments,overdue")
	values.Set("sectionLimit", strconv.Itoa(maxBriefingSectionCeiling))
	return "?" + values.Encode()
}

// strictSelector is the scope_project selector with the unscoped widening off.
func strictSelector(s briefingSelector) briefingSelector {
	off := false
	s.IncludeUnscoped = &off
	return s
}

// selectorWithin reports whether the server's effective selector is the one
// asked for or narrower. Briefing items carry no scope or project, so this echo
// is the list's only server-side isolation evidence: a wider echo fails the read
// instead of showing rows from outside the requested boundary.
func selectorWithin(requested, effective briefingSelector) bool {
	if effective.Kind != requested.Kind || effective.Scope != requested.Scope || effective.Project != requested.Project {
		return false
	}
	effWidened := effective.IncludeUnscoped != nil && *effective.IncludeUnscoped
	reqWidened := requested.IncludeUnscoped != nil && *requested.IncludeUnscoped
	return !effWidened || reqWidened
}

// mergeSections unions the commitments slice and the overdue split in server
// order, one row per memory. The overdue split can hold rows the bounded
// commitments slice cut, so it is merged rather than ignored.
func mergeSections(commitments, overdue commitmentSection) []commitmentRow {
	seen := map[string]struct{}{}
	rows := make([]commitmentRow, 0, len(commitments.Items)+len(overdue.Items))
	add := func(item briefingCommitment, overdueSplit bool) {
		if _, dup := seen[item.MemoryID]; dup {
			return
		}
		seen[item.MemoryID] = struct{}{}
		row := commitmentRow{
			MemoryID:     item.MemoryID,
			CommitmentID: item.ID,
			Topic:        item.Topic,
			Status:       item.Status,
			Overdue:      item.Overdue || overdueSplit,
			Filing:       filingProject,
			Ownership:    unclearOwnership,
		}
		if item.DueAt != "" {
			due := item.DueAt
			row.DueAt = &due
		}
		rows = append(rows, row)
	}
	for _, item := range commitments.Items {
		add(item, false)
	}
	for _, item := range overdue.Items {
		add(item, true)
	}
	return rows
}

// truncationParts labels each section the server cut.
func truncationParts(resp briefingResponse) []partialPart {
	var parts []partialPart
	if resp.Commitments.HasMore || resp.Commitments.Count > len(resp.Commitments.Items) {
		parts = append(parts, countedPart("commitments", "truncated", len(resp.Commitments.Items), resp.Commitments.Count))
	}
	if resp.Overdue.HasMore || resp.Overdue.Count > len(resp.Overdue.Items) {
		parts = append(parts, countedPart("overdue", "truncated", len(resp.Overdue.Items), resp.Overdue.Count))
	}
	return parts
}

type filedRows struct {
	rows    []commitmentRow
	changed int
	partial []partialPart
}

// fileRows assigns each row its filing. Without the unscoped widening every row
// came through the strict server filter and is `project`. With it, a row is
// `project` when the strict read also returned it. A row only the widened read
// returned is a CANDIDATE, never assumed unscoped: the strict slice is bounded
// and read at a different instant, so absence proves nothing. Each candidate's
// memory is read back. It is `unscoped` only with project = null in the
// requested scope, `project` with the requested project, and is dropped as
// changed during the read otherwise. A candidate that could not be read is
// `unknown`.
func fileRows(ctx context.Context, rows []commitmentRow, requested briefingSelector, widened bool, strict *briefingResponse) filedRows {
	if !widened {
		return filedRows{rows: rows}
	}
	out := filedRows{rows: []commitmentRow{}}
	inStrict := map[string]struct{}{}
	if strict != nil {
		for _, item := range strict.Commitments.Items {
			inStrict[item.MemoryID] = struct{}{}
		}
		for _, item := range strict.Overdue.Items {
			inStrict[item.MemoryID] = struct{}{}
		}
	}

	var candidates []int
	for i := range rows {
		if _, ok := inStrict[rows[i].MemoryID]; ok {
			rows[i].Filing = filingProject
			continue
		}
		rows[i].Filing = filingUnknown
		candidates = append(candidates, i)
	}

	lookups := candidates
	if len(lookups) > maxFilingLookups {
		lookups = lookups[:maxFilingLookups]
	}
	verdicts := make([]filingVerdict, len(lookups))
	forEachBounded(ctx, len(lookups), readConcurrency, func(ctx context.Context, n int) {
		verdicts[n] = verifyFiling(ctx, rows[lookups[n]].MemoryID, requested)
	})

	drop := map[int]struct{}{}
	verified, failedKind := 0, ""
	for n, idx := range lookups {
		switch v := verdicts[n]; {
		case !v.done:
			// Never started: the deadline (or a cancel) stopped the launch.
			failedKind = classifyReadFailure(ctx, "memory", 0, nil).Kind
		case v.err != nil:
			failedKind = v.err.Kind
		case v.drop:
			drop[idx] = struct{}{}
			out.changed++
			verified++
		default:
			rows[idx].Filing = v.filing
			verified++
		}
	}
	if verified < len(candidates) {
		reason := "lookup_cap"
		if failedKind != "" {
			reason = failedKind
		}
		out.partial = append(out.partial, countedPart("filing", reason, verified, len(candidates)))
	}
	for i, row := range rows {
		if _, gone := drop[i]; !gone {
			out.rows = append(out.rows, row)
		}
	}
	return out
}

// filingVerdict is one lookup's outcome. done is false for a lookup the
// deadline kept from starting.
type filingVerdict struct {
	done   bool
	filing string
	drop   bool
	err    *readError
}

// verifyFiling reads one candidate's memory and decides its filing from the
// stored row, not from which response it appeared in.
func verifyFiling(ctx context.Context, memoryID string, requested briefingSelector) filingVerdict {
	path, ok := memoryPath(memoryID, "")
	if !ok {
		return filingVerdict{done: true, err: &readError{Kind: kindBadResponse, Route: "memory"}}
	}
	var m memoryFiling
	if err := apiGet(ctx, "memory", path, &m); err != nil {
		// Gone between the two reads: it left the selector, like a move.
		if err.Kind == kindNotFound {
			return filingVerdict{done: true, drop: true}
		}
		return filingVerdict{done: true, err: err}
	}
	if m.Status != "active" || m.ValidTo != nil || m.Scope != requested.Scope {
		return filingVerdict{done: true, drop: true}
	}
	if m.Project == nil {
		return filingVerdict{done: true, filing: filingUnscoped}
	}
	if *m.Project == requested.Project {
		return filingVerdict{done: true, filing: filingProject}
	}
	return filingVerdict{done: true, drop: true}
}

// forEachBounded runs fn for 0..n-1 with at most limit in flight. It stops
// starting new work once ctx is done; work it never started leaves its slot at
// the zero value, which callers treat as not done.
func forEachBounded(ctx context.Context, n, limit int, fn func(context.Context, int)) {
	sem := make(chan struct{}, limit)
	var wg sync.WaitGroup
launch:
	for i := 0; i < n; i++ {
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			break launch
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			fn(ctx, i)
		}(i)
	}
	wg.Wait()
}
