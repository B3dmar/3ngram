// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"sync"
)

// `3ngram-hook commitments show <memoryId> [--expect-fingerprint F] [selector]`
// reads one commitment for the panel's detail view: the stored memory, its
// history and evidence. Isolation is decided by the FIRST request: the memory
// is read and checked against the selector, and a commitment outside it ends
// the operation with `outside_selector`, no topic or content, and no further
// request. Everything the history returns about OTHER memories (lineage nodes,
// edges, relationships) is kept only when that memory is inside the selector
// too; the rest is reduced to counts.

const (
	kindContextChanged  = "context_changed"
	kindOutsideSelector = "outside_selector"
)

// memoryDetail is GET /api/v1/memories/:id.
type memoryDetail struct {
	ID               string       `json:"id"`
	MemoryType       string       `json:"memoryType"`
	Topic            string       `json:"topic"`
	Content          string       `json:"content"`
	Scope            string       `json:"scope"`
	Project          jsonNullable `json:"project"`
	Status           string       `json:"status"`
	CommitmentStatus string       `json:"commitmentStatus"`
	Tags             []string     `json:"tags"`
	ValidFrom        string       `json:"validFrom"`
	ValidTo          jsonNullable `json:"validTo"`
	RecordedAt       string       `json:"recordedAt"`
}

// historyMemory is the identity-only memory shape the history route returns
// for the memory itself, lineage nodes and relationship partners.
type historyMemory struct {
	ID             string       `json:"id"`
	MemoryType     string       `json:"memoryType"`
	Topic          string       `json:"topic"`
	Project        jsonNullable `json:"project"`
	Scope          string       `json:"scope"`
	Status         string       `json:"status"`
	ValidTo        jsonNullable `json:"validTo"`
	RecordedAt     string       `json:"recordedAt"`
	IsCurrent      bool         `json:"isCurrent"`
	LifecycleState string       `json:"lifecycleState"`
}

type historyEdge struct {
	ID        string `json:"id"`
	FromID    string `json:"fromId"`
	ToID      string `json:"toId"`
	EdgeType  string `json:"edgeType"`
	CreatedBy string `json:"createdBy"`
	CreatedAt string `json:"createdAt"`
}

type historyRelationship struct {
	Memory historyMemory `json:"memory"`
	Edge   historyEdge   `json:"edge"`
}

type auditEvent struct {
	EventKind string `json:"eventKind"`
	ActorKind string `json:"actorKind"`
	CreatedAt string `json:"createdAt"`
}

// historyResponse is GET /api/v1/memories/:id/history. Event payloads are
// redacted by the server and not read here.
type historyResponse struct {
	Memory  historyMemory `json:"memory"`
	Lineage struct {
		Nodes     []historyMemory `json:"nodes"`
		Edges     []historyEdge   `json:"edges"`
		Truncated bool            `json:"truncated"`
	} `json:"lineage"`
	DirectRelationships struct {
		Predecessors []historyRelationship `json:"predecessors"`
		Successors   []historyRelationship `json:"successors"`
		Truncated    bool                  `json:"truncated"`
	} `json:"directRelationships"`
	AuditEvents     []auditEvent `json:"auditEvents"`
	EventsTruncated bool         `json:"eventsTruncated"`
	Sections        struct {
		Lineage string `json:"lineage"`
		Events  string `json:"events"`
	} `json:"sections"`
}

// commitmentDetail is the commitment as the detail view shows it. It is only
// ever built for a memory inside the selector.
type commitmentDetail struct {
	MemoryID         string   `json:"memoryId"`
	MemoryType       string   `json:"memoryType"`
	Topic            string   `json:"topic"`
	Content          string   `json:"content"`
	Scope            string   `json:"scope"`
	Project          *string  `json:"project"`
	Filing           string   `json:"filing"`
	Status           string   `json:"status"`
	CommitmentStatus string   `json:"commitmentStatus,omitempty"`
	Current          bool     `json:"current"`
	Tags             []string `json:"tags"`
	ValidFrom        string   `json:"validFrom"`
	ValidTo          *string  `json:"validTo"`
	RecordedAt       string   `json:"recordedAt"`
}

// commitmentSource says what is known about where the commitment came from.
// The session it was written in is not exposed by any read route (history
// payloads are redacted), so it is always null with that reason.
type commitmentSource struct {
	CreatedBy     *string `json:"createdBy"`
	CreatedAt     *string `json:"createdAt"`
	Session       *string `json:"session"`
	SessionReason string  `json:"sessionReason"`
}

type commitmentHistory struct {
	// lineageOK is false when the server could not read the lineage and
	// relationships; they are then empty and say nothing.
	lineageOK       bool
	Events          []auditEvent          `json:"events"`
	EventsTruncated bool                  `json:"eventsTruncated"`
	Lineage         []historyMemory       `json:"lineage"`
	Edges           []historyEdge         `json:"edges"`
	Relationships   []historyRelationship `json:"relationships"`
	// The two sections the server caps separately: lineage at 25 nodes and
	// 50 edges, direct relationships at 50.
	LineageTruncated       bool         `json:"lineageTruncated"`
	RelationshipsTruncated bool         `json:"relationshipsTruncated"`
	Hidden                 hiddenCounts `json:"hiddenOutsideSelector"`
}

// hiddenCounts is what redaction removed from the history: how many, never
// which. Proposals are counted in the evidence block instead.
type hiddenCounts struct {
	Nodes         int `json:"nodes"`
	Edges         int `json:"edges"`
	Relationships int `json:"relationships"`
}

// historyShape is the presence view of a history answer. Each group the route
// always sends is a pointer, so an omitted or null group is told apart from an
// empty one. sections is optional by contract: older servers omit it, and that
// means every section loaded. Omitted is not null, though, so it is kept raw.
type historyShape struct {
	Memory  *json.RawMessage `json:"memory"`
	Lineage *struct {
		Nodes     *[]json.RawMessage `json:"nodes"`
		Edges     *[]json.RawMessage `json:"edges"`
		Truncated *bool              `json:"truncated"`
	} `json:"lineage"`
	DirectRelationships *struct {
		Predecessors *[]json.RawMessage `json:"predecessors"`
		Successors   *[]json.RawMessage `json:"successors"`
		Truncated    *bool              `json:"truncated"`
	} `json:"directRelationships"`
	AuditEvents     *[]json.RawMessage `json:"auditEvents"`
	EventsTruncated *bool              `json:"eventsTruncated"`
	Sections        json.RawMessage    `json:"sections"`
}

type historySectionsShape struct {
	Lineage *string `json:"lineage"`
	Events  *string `json:"events"`
}

// decodeHistory accepts a history answer only when it is about memoryID and
// complete. A group that is missing would otherwise decode as an empty one,
// and an empty lineage reads as a searched window with nothing in it.
func decodeHistory(raw json.RawMessage, memoryID string) (historyResponse, *readError) {
	bad := &readError{Kind: kindBadResponse, Route: "history"}
	var shape historyShape
	var h historyResponse
	if json.Unmarshal(raw, &shape) != nil || json.Unmarshal(raw, &h) != nil {
		return historyResponse{}, bad
	}
	l, d := shape.Lineage, shape.DirectRelationships
	if shape.Memory == nil || l == nil || l.Nodes == nil || l.Edges == nil || l.Truncated == nil ||
		d == nil || d.Predecessors == nil || d.Successors == nil || d.Truncated == nil ||
		shape.AuditEvents == nil || shape.EventsTruncated == nil {
		return historyResponse{}, bad
	}
	if shape.Sections != nil {
		var sec *historySectionsShape
		if json.Unmarshal(shape.Sections, &sec) != nil || sec == nil ||
			!knownSectionStatus(sec.Lineage) || !knownSectionStatus(sec.Events) {
			return historyResponse{}, bad
		}
	}
	if !strings.EqualFold(h.Memory.ID, memoryID) {
		return historyResponse{}, bad
	}
	// Every memory the history names must state its filing. Without it the
	// memory can neither be shown nor honestly counted as outside the selector.
	for _, node := range h.Lineage.Nodes {
		if node.ID == "" || !statesFiling(node.Scope, node.Project) {
			return historyResponse{}, bad
		}
	}
	for _, rel := range append(append([]historyRelationship{}, h.DirectRelationships.Predecessors...), h.DirectRelationships.Successors...) {
		if rel.Memory.ID == "" || !statesFiling(rel.Memory.Scope, rel.Memory.Project) {
			return historyResponse{}, bad
		}
	}
	return h, nil
}

func knownSectionStatus(status *string) bool {
	return status != nil && (*status == "ok" || *status == "unavailable")
}

// statesFiling reports whether an answer said where a memory is filed: a
// scope (never empty in a real row) and a project field, null or not.
func statesFiling(scope string, project jsonNullable) bool {
	return scope != "" && project.Present
}

// memoryInSelector decides membership exactly as the briefing filter does:
// kind=project matches the project in any scope; scope_project matches the
// scope and project, plus a null project only when unscoped records were asked
// for.
//
// project must have been in the answer: an omitted project is not a null one,
// and a memory whose filing the answer does not state is outside.
func memoryInSelector(scope string, project jsonNullable, sel briefingSelector) (bool, string) {
	if !project.Present {
		return false, ""
	}
	switch sel.Kind {
	case "project":
		if project.Value != nil && *project.Value == sel.Project {
			return true, filingProject
		}
	case "scope_project":
		if scope != sel.Scope {
			return false, ""
		}
		if project.Value != nil && *project.Value == sel.Project {
			return true, filingProject
		}
		if project.Value == nil && sel.IncludeUnscoped != nil && *sel.IncludeUnscoped {
			return true, filingUnscoped
		}
	}
	return false, ""
}

// showCommitment runs the detail read under the operation's deadline in ctx.
func showCommitment(ctx context.Context, cfg readConfig, env commitmentsEnvelope, memoryID, expect string, gh githubOptions, stderr io.Writer) commitmentsEnvelope {
	if cfg.key == "" {
		return failEnvelope(env, &readError{Kind: kindNoKey, Route: "config"})
	}
	if selErr := validateCommitmentsSelector(env.Context); selErr != nil {
		return failEnvelope(env, selErr)
	}
	memoryURL, okID := memoryPath(memoryID, "")
	// Compared first, before any request: a detail asked for under a context
	// that has since changed is refused without reading anything.
	if expect != "" && expect != env.Context.Fingerprint {
		return failEnvelope(env, &readError{Kind: kindContextChanged, Route: "context"})
	}
	if !okID {
		return failEnvelope(env, &readError{Kind: kindUsage, Route: "args", Hint: "show needs a memory id"})
	}
	sel := env.Context.Requested

	var memory memoryDetail
	if err := apiGet(ctx, cfg, "memory", memoryURL, &memory); err != nil {
		logReadFailure(stderr, err)
		return failEnvelope(env, err)
	}
	// From here on the id is the server's own spelling of it. The requested
	// one may differ in case (uuid matching ignores it), and every later
	// comparison, against history and proposal ids, uses the server's form.
	if !strings.EqualFold(memory.ID, memoryID) {
		return failEnvelope(env, &readError{Kind: kindBadResponse, Route: "memory", Hint: "the server answered for another id"})
	}
	if !memory.ValidTo.Present {
		return failEnvelope(env, &readError{Kind: kindBadResponse, Route: "memory", Hint: "validTo missing"})
	}
	memoryID = memory.ID
	historyURL, _ := memoryPath(memoryID, "/history")
	inside, filing := memoryInSelector(memory.Scope, memory.Project, sel)
	if !inside || memory.MemoryType != "commitment" {
		return failEnvelope(env, &readError{Kind: kindOutsideSelector, Route: "memory"})
	}

	var history historyResponse
	var historyRaw json.RawMessage
	var proposals proposalsResponse
	var historyErr, proposalsErr *readError
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if historyErr = apiGet(ctx, cfg, "history", historyURL, &historyRaw); historyErr == nil {
			history, historyErr = decodeHistory(historyRaw, memoryID)
		}
	}()
	go func() {
		defer wg.Done()
		proposalsErr = apiGet(ctx, cfg, "proposals", proposalsQuery(), &proposals)
	}()
	wg.Wait()
	// A proposals answer without its list describes nothing about this
	// commitment (decodeHistory holds the history answer to the same rule).
	if proposalsErr == nil && proposals.Proposals == nil {
		proposalsErr = &readError{Kind: kindBadResponse, Route: "proposals"}
	}

	if memory.Tags == nil {
		memory.Tags = []string{}
	}
	env.Commitment = &commitmentDetail{
		MemoryID: memory.ID, MemoryType: memory.MemoryType, Topic: memory.Topic, Content: memory.Content,
		Scope: memory.Scope, Project: memory.Project.Value, Filing: filing, Status: memory.Status,
		CommitmentStatus: memory.CommitmentStatus, Current: memory.ValidTo.Value == nil && memory.Status == "active",
		Tags: memory.Tags, ValidFrom: memory.ValidFrom, ValidTo: memory.ValidTo.Value, RecordedAt: memory.RecordedAt,
	}
	env.Source = &commitmentSource{SessionReason: "not_exposed"}

	var visible map[string]bool
	if historyErr != nil {
		logReadFailure(stderr, historyErr)
		env.Partial = append(env.Partial, partialPart{Part: "history", Reason: historyErr.Kind})
		visible = map[string]bool{memoryID: true}
	} else {
		env.History, visible = redactHistory(memoryID, history, sel)
		env.Source.CreatedBy, env.Source.CreatedAt = creationOf(history.AuditEvents)
		env.Partial = append(env.Partial, historySectionParts(history)...)
	}

	env.Evidence = collectEvidence(ctx, cfg, memoryID, sel, env.History, visible, proposals, proposalsErr, stderr)
	if gh.enabled {
		// Topic and content are scanned apart, so the end of one field never
		// changes how the start of the other reads.
		bare := bareRepoFor(gh.remote, filing, sel)
		refs, window := capRefs([]refScan{extractGitHubRefs(memory.Topic, bare), extractGitHubRefs(memory.Content, bare)})
		found, failure, checked := githubBatch(ctx, refs)
		window.Checked = checked
		env.Evidence.GitHub = sortedEvidence(refs, found)
		env.Evidence.Inspected.GitHub = &window
		env.Evidence.partial = append(env.Evidence.partial, githubParts(window, failure)...)
		env.Evidence.decideVerdict()
	}
	env.Partial = append(env.Partial, env.Evidence.partial...)
	env.Missing = []string{"owner", "sourceSession", "resolveReason"}
	env.OK = true
	return env
}

// redactHistory keeps what the history says about the commitment itself and
// about memories inside the selector, and reduces everything else to counts.
// It returns the set of memory ids the caller may show, which edges and
// proposals are then checked against.
func redactHistory(memoryID string, h historyResponse, sel briefingSelector) (*commitmentHistory, map[string]bool) {
	out := &commitmentHistory{
		lineageOK:              h.Sections.Lineage != "unavailable",
		Events:                 h.AuditEvents,
		EventsTruncated:        h.EventsTruncated,
		Lineage:                []historyMemory{},
		Edges:                  []historyEdge{},
		Relationships:          []historyRelationship{},
		LineageTruncated:       h.Lineage.Truncated,
		RelationshipsTruncated: h.DirectRelationships.Truncated,
	}
	if out.Events == nil {
		out.Events = []auditEvent{}
	}
	visible := map[string]bool{memoryID: true}
	for _, node := range h.Lineage.Nodes {
		if node.ID == memoryID {
			continue
		}
		if ok, _ := memoryInSelector(node.Scope, node.Project, sel); ok {
			visible[node.ID] = true
			out.Lineage = append(out.Lineage, node)
		} else {
			out.Hidden.Nodes++
		}
	}
	keepRelationship := func(rel historyRelationship) {
		if ok, _ := memoryInSelector(rel.Memory.Scope, rel.Memory.Project, sel); ok {
			visible[rel.Memory.ID] = true
			out.Relationships = append(out.Relationships, rel)
		} else {
			out.Hidden.Relationships++
		}
	}
	for _, rel := range h.DirectRelationships.Successors {
		keepRelationship(rel)
	}
	for _, rel := range h.DirectRelationships.Predecessors {
		keepRelationship(rel)
	}
	// An edge is shown only when BOTH its ends are: its ids alone would
	// otherwise confirm that a hidden memory exists and how it relates.
	for _, edge := range h.Lineage.Edges {
		if visible[edge.FromID] && visible[edge.ToID] {
			out.Edges = append(out.Edges, edge)
		} else {
			out.Hidden.Edges++
		}
	}
	return out, visible
}

// creationOf reads who and when from the commitment's create (or import)
// event, when the bounded event list reached back that far.
func creationOf(events []auditEvent) (*string, *string) {
	for _, ev := range events {
		if ev.EventKind == "create" || ev.EventKind == "import" {
			actor, at := ev.ActorKind, ev.CreatedAt
			return &actor, &at
		}
	}
	return nil, nil
}

func historySectionParts(h historyResponse) []partialPart {
	var parts []partialPart
	if h.Sections.Lineage == "unavailable" {
		parts = append(parts, partialPart{Part: "lineage", Reason: kindUnavailable})
	}
	if h.Sections.Events == "unavailable" {
		parts = append(parts, partialPart{Part: "events", Reason: kindUnavailable})
	}
	if h.Lineage.Truncated {
		parts = append(parts, partialPart{Part: "lineage", Reason: "truncated"})
	}
	if h.DirectRelationships.Truncated {
		parts = append(parts, partialPart{Part: "relationships", Reason: "truncated"})
	}
	if h.EventsTruncated {
		parts = append(parts, partialPart{Part: "events", Reason: "truncated"})
	}
	return parts
}
