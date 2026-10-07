// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"io"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
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
	ID    string       `json:"id"`
	Email jsonNullable `json:"email"`
}

// memoryFiling is the subset of GET /api/v1/memories/:id the filing check
// reads. Content is in that body too, and is discarded here.
type memoryFiling struct {
	ID               string       `json:"id"`
	Scope            string       `json:"scope"`
	Project          jsonNullable `json:"project"`
	Status           string       `json:"status"`
	ValidTo          jsonNullable `json:"validTo"`
	CommitmentStatus string       `json:"commitmentStatus"`
}

// listBriefing is the briefing body as the list reads it. The two sections
// are pointers, and so are their count and items, so a 200 that omits either
// is told apart from an empty one and fails as bad_response instead of being
// shown as "no commitments".
type listBriefing struct {
	Selector    briefingSelector `json:"selector"`
	GeneratedAt string           `json:"generatedAt"`
	Commitments *listSection     `json:"commitments"`
	Overdue     *listSection     `json:"overdue"`
}

type listSection struct {
	Count   *int        `json:"count"`
	Items   *[]listItem `json:"items"`
	HasMore *bool       `json:"hasMore"`
}

// listItem is one briefing commitment with every required field tracked for
// presence: an item that omits one cannot be shown or de-duplicated safely,
// so it fails the read instead of becoming an empty-id row.
type listItem struct {
	ID       *string      `json:"id"`
	MemoryID *string      `json:"memoryId"`
	Topic    *string      `json:"topic"`
	Status   *string      `json:"status"`
	DueAt    jsonNullable `json:"dueAt"`
	Overdue  *bool        `json:"overdue"`
}

func (it listItem) commitment() (briefingCommitment, bool) {
	if it.ID == nil || *it.ID == "" || it.MemoryID == nil || *it.MemoryID == "" ||
		it.Status == nil || *it.Status == "" || it.Topic == nil || !it.DueAt.Present || it.Overdue == nil {
		return briefingCommitment{}, false
	}
	c := briefingCommitment{ID: *it.ID, MemoryID: *it.MemoryID, Topic: *it.Topic, Status: *it.Status, Overdue: *it.Overdue}
	if it.DueAt.Value != nil {
		c.DueAt = *it.DueAt.Value
	}
	return c, true
}

// sections returns both sections, or false when either is incomplete.
func (b listBriefing) sections() (commitmentSection, commitmentSection, bool) {
	c, okC := b.Commitments.section()
	o, okO := b.Overdue.section()
	return c, o, okC && okO
}

func (s *listSection) section() (commitmentSection, bool) {
	if s == nil || s.Count == nil || s.Items == nil {
		return commitmentSection{}, false
	}
	items := make([]briefingCommitment, 0, len(*s.Items))
	for _, it := range *s.Items {
		c, ok := it.commitment()
		if !ok {
			return commitmentSection{}, false
		}
		items = append(items, c)
	}
	// The briefing contract's own invariants: the count covers the slice, and
	// hasMore says exactly whether it is short of the count. A section that
	// breaks either would report contradictory counts or a false truncation.
	// More rows than the request's sectionLimit allows is not this read's
	// answer either, however consistent its own counts are.
	if *s.Count < len(items) || len(items) > maxBriefingSectionCeiling {
		return commitmentSection{}, false
	}
	out := commitmentSection{Count: *s.Count, Items: items}
	// An older server without the hasMore signal still reports truncation
	// through count > items, which truncationParts reads too; one that sends
	// it must send the value the count implies.
	if s.HasMore != nil {
		if *s.HasMore != (*s.Count > len(items)) {
			return commitmentSection{}, false
		}
		out.HasMore = *s.HasMore
	}
	return out, true
}

// listCommitments reads the selector's open and waiting commitments under the
// operation's single deadline in ctx, with the one credential cfg pinned for
// the whole operation.
func listCommitments(ctx context.Context, cfg readConfig, env commitmentsEnvelope, stderr io.Writer) commitmentsEnvelope {
	if cfg.key == "" {
		return failEnvelope(env, &readError{Kind: kindNoKey, Route: "config"})
	}
	if selErr := validateCommitmentsSelector(env.Context); selErr != nil {
		return failEnvelope(env, selErr)
	}
	requested := env.Context.Requested
	widened := requested.IncludeUnscoped != nil && *requested.IncludeUnscoped

	var me meResponse
	var wide listBriefing
	var meErr, wideErr *readError
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); meErr = apiGet(ctx, cfg, "me", "/api/v1/me", &me) }()
	go func() {
		defer wg.Done()
		wideErr = apiGet(ctx, cfg, "briefing", "/api/v1/briefing"+buildCommitmentsQuery(requested), &wide)
	}()
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
	commitments, overdue, complete := wide.sections()
	// generatedAt is the read's freshness: a list without a valid timestamp
	// is incomplete.
	if !complete || !validTimestamp(wide.GeneratedAt) {
		incomplete := &readError{Kind: kindBadResponse, Route: "briefing", Hint: "commitment sections missing or inconsistent"}
		logReadFailure(stderr, incomplete)
		return failEnvelope(env, incomplete)
	}
	effective := wide.Selector
	env.Context.Effective = &effective

	// A 200 without the account's id and email is not an identity: the
	// header would show a blank account under real rows.
	if meErr == nil && (me.ID == "" || !me.Email.Present) {
		meErr = &readError{Kind: kindBadResponse, Route: "me"}
	}
	if meErr == nil {
		email := ""
		if me.Email.Value != nil {
			email = *me.Email.Value
		}
		env.Context.Account = &accountInfo{ID: me.ID, Email: email}
	} else {
		logReadFailure(stderr, meErr)
		env.Partial = append(env.Partial, partialPart{Part: "account", Reason: meErr.Kind})
	}

	rows := mergeSections(commitments, overdue)
	var strictPtr *strictSnapshot
	if widened {
		snapshot, strictErr := readStrict(ctx, cfg, requested)
		if strictErr != nil {
			logReadFailure(stderr, strictErr)
			env.Partial = append(env.Partial, partialPart{Part: "filing", Reason: "strict_read_" + strictErr.Kind})
		} else {
			strictPtr = &snapshot
		}
	}
	filed := fileRows(ctx, cfg, rows, requested, widened, strictPtr)
	env.Partial = append(env.Partial, filed.partial...)

	env.Counts = &commitmentCounts{
		OpenOrWaiting:     commitments.Count,
		Overdue:           overdue.Count,
		Returned:          len(filed.rows),
		ChangedDuringRead: filed.changed,
	}
	env.Partial = append(env.Partial, truncationParts(commitments, overdue)...)
	env.Commitments = &filed.rows
	env.Missing = []string{"owner", "sourceSession"}
	env.GeneratedAt = wide.GeneratedAt
	env.OK = true
	return env
}

// strictSnapshot is the set of memory ids the strict read returned.
type strictSnapshot map[string]struct{}

// readStrict runs the strict read AFTER the widened one, never beside it. A
// row it returns is labelled `project` with no lookup, so it must describe the
// row's filing at or after the moment the widened read saw it: a row that moved
// from the project to unscoped in between is then absent here and verified.
// Its echo is held to selectorWithin like the widened one, and an incomplete
// body counts as a failed read.
func readStrict(ctx context.Context, cfg readConfig, requested briefingSelector) (strictSnapshot, *readError) {
	var strict listBriefing
	if err := apiGet(ctx, cfg, "briefing", "/api/v1/briefing"+buildCommitmentsQuery(strictSelector(requested)), &strict); err != nil {
		return nil, err
	}
	if !selectorWithin(strictSelector(requested), strict.Selector) {
		return nil, &readError{Kind: kindSelectorMismatch, Route: "briefing"}
	}
	commitments, overdue, complete := strict.sections()
	if !complete {
		return nil, &readError{Kind: kindBadResponse, Route: "briefing"}
	}
	ids := strictSnapshot{}
	for _, item := range commitments.Items {
		ids[item.MemoryID] = struct{}{}
	}
	for _, item := range overdue.Items {
		ids[item.MemoryID] = struct{}{}
	}
	return ids, nil
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
func truncationParts(commitments, overdue commitmentSection) []partialPart {
	var parts []partialPart
	if commitments.HasMore || commitments.Count > len(commitments.Items) {
		parts = append(parts, countedPart("commitments", "truncated", len(commitments.Items), commitments.Count))
	}
	if overdue.HasMore || overdue.Count > len(overdue.Items) {
		parts = append(parts, countedPart("overdue", "truncated", len(overdue.Items), overdue.Count))
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
func fileRows(ctx context.Context, cfg readConfig, rows []commitmentRow, requested briefingSelector, widened bool, strict *strictSnapshot) filedRows {
	if !widened {
		return filedRows{rows: rows}
	}
	out := filedRows{rows: []commitmentRow{}}
	inStrict := strictSnapshot{}
	if strict != nil {
		inStrict = *strict
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
		verdicts[n] = verifyFiling(ctx, cfg, rows[lookups[n]].MemoryID, requested)
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

// validTimestamp reports whether s is the ISO datetime the briefing contract
// requires.
func validTimestamp(s string) bool {
	_, err := time.Parse(time.RFC3339Nano, s)
	return err == nil
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
func verifyFiling(ctx context.Context, cfg readConfig, memoryID string, requested briefingSelector) filingVerdict {
	path, ok := memoryPath(memoryID, "")
	if !ok {
		return filingVerdict{done: true, err: &readError{Kind: kindBadResponse, Route: "memory"}}
	}
	var m memoryFiling
	if err := apiGet(ctx, cfg, "memory", path, &m); err != nil {
		// A 404 does not prove the row left the selector: memory rows are never
		// deleted, so a move or a supersession still answers. It may be a
		// skewed route or a bad id, so the row stays, unknown, like any
		// other failed lookup.
		return filingVerdict{done: true, err: err}
	}
	// An answer for another memory, or one that omits a required field
	// (project and validTo are required but nullable), says nothing about this
	// row's filing: it stays unknown, never unscoped and never dropped.
	if !strings.EqualFold(m.ID, memoryID) || !m.Project.Present || !m.ValidTo.Present ||
		m.Scope == "" || m.Status == "" || m.CommitmentStatus == "" {
		return filingVerdict{done: true, err: &readError{Kind: kindBadResponse, Route: "memory"}}
	}
	listed, known := commitmentListed(m.CommitmentStatus)
	if !known {
		return filingVerdict{done: true, err: &readError{Kind: kindBadResponse, Route: "memory", Hint: "unrecognised commitment status"}}
	}
	// No longer live (superseded, archived, or the commitment resolved or
	// expired since the widened read listed it): it left the list.
	if m.Status != "active" || m.ValidTo.Value != nil || m.Scope != requested.Scope || !listed {
		return filingVerdict{done: true, drop: true}
	}
	if m.Project.Value == nil {
		return filingVerdict{done: true, filing: filingUnscoped}
	}
	if *m.Project.Value == requested.Project {
		return filingVerdict{done: true, filing: filingProject}
	}
	return filingVerdict{done: true, drop: true}
}

// commitmentListed reads a commitment status the way the briefing filter does
// (packages/db/src/briefing-read.ts lists open and waiting). known is false
// for a status this build does not recognise, so a status a later schema adds
// leaves the row unknown rather than dropping it as resolved.
func commitmentListed(status string) (listed, known bool) {
	switch status {
	case "open", "waiting":
		return true, true
	case "resolved", "expired":
		return false, true
	}
	return false, false
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
		// Both cases can be ready at once, and select picks at random: a
		// cancelled batch must not launch another lookup.
		if ctx.Err() != nil {
			<-sem
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
