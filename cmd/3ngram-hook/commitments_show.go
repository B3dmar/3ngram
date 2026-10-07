// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
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
	ID               string   `json:"id"`
	MemoryType       string   `json:"memoryType"`
	Topic            string   `json:"topic"`
	Content          string   `json:"content"`
	Scope            string   `json:"scope"`
	Project          *string  `json:"project"`
	Status           string   `json:"status"`
	CommitmentStatus string   `json:"commitmentStatus"`
	Tags             []string `json:"tags"`
	ValidFrom        string   `json:"validFrom"`
	ValidTo          *string  `json:"validTo"`
	RecordedAt       string   `json:"recordedAt"`
}

// historyMemory is the identity-only memory shape the history route returns
// for the memory itself, lineage nodes and relationship partners.
type historyMemory struct {
	ID             string  `json:"id"`
	MemoryType     string  `json:"memoryType"`
	Topic          string  `json:"topic"`
	Project        *string `json:"project"`
	Scope          string  `json:"scope"`
	Status         string  `json:"status"`
	ValidTo        *string `json:"validTo"`
	RecordedAt     string  `json:"recordedAt"`
	IsCurrent      bool    `json:"isCurrent"`
	LifecycleState string  `json:"lifecycleState"`
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
	Events          []auditEvent          `json:"events"`
	EventsTruncated bool                  `json:"eventsTruncated"`
	Lineage         []historyMemory       `json:"lineage"`
	Edges           []historyEdge         `json:"edges"`
	Relationships   []historyRelationship `json:"relationships"`
	Truncated       bool                  `json:"truncated"`
	Hidden          hiddenCounts          `json:"hiddenOutsideSelector"`
}

// hiddenCounts is what redaction removed from the history: how many, never
// which. Proposals are counted in the evidence block instead.
type hiddenCounts struct {
	Nodes         int `json:"nodes"`
	Edges         int `json:"edges"`
	Relationships int `json:"relationships"`
}

// The history route's own caps (packages/db/src/memory-history-queries.ts),
// reported in the evidence window so "nothing found" says how far it looked.
const (
	historyLineageNodeCap = 25
	historyEventCap       = 50
)

// memoryInSelector decides membership exactly as the briefing filter does:
// kind=project matches the project in any scope; scope_project matches the
// scope and project, plus a null project only when unscoped records were asked
// for.
func memoryInSelector(scope string, project *string, sel briefingSelector) (bool, string) {
	switch sel.Kind {
	case "project":
		if project != nil && *project == sel.Project {
			return true, filingProject
		}
	case "scope_project":
		if scope != sel.Scope {
			return false, ""
		}
		if project != nil && *project == sel.Project {
			return true, filingProject
		}
		if project == nil && sel.IncludeUnscoped != nil && *sel.IncludeUnscoped {
			return true, filingUnscoped
		}
	}
	return false, ""
}

// showCommitment runs the detail read under the operation's deadline in ctx.
func showCommitment(ctx context.Context, cfg readConfig, env commitmentsEnvelope, memoryID, expect string, stderr io.Writer) commitmentsEnvelope {
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
	memoryID = memory.ID
	historyURL, _ := memoryPath(memoryID, "/history")
	inside, filing := memoryInSelector(memory.Scope, memory.Project, sel)
	if !inside || memory.MemoryType != "commitment" {
		return failEnvelope(env, &readError{Kind: kindOutsideSelector, Route: "memory"})
	}

	var history historyResponse
	var proposals proposalsResponse
	var historyErr, proposalsErr *readError
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		historyErr = apiGet(ctx, cfg, "history", historyURL, &history)
	}()
	go func() {
		defer wg.Done()
		proposalsErr = apiGet(ctx, cfg, "proposals", proposalsQuery(), &proposals)
	}()
	wg.Wait()

	if memory.Tags == nil {
		memory.Tags = []string{}
	}
	env.Commitment = &commitmentDetail{
		MemoryID: memory.ID, MemoryType: memory.MemoryType, Topic: memory.Topic, Content: memory.Content,
		Scope: memory.Scope, Project: memory.Project, Filing: filing, Status: memory.Status,
		CommitmentStatus: memory.CommitmentStatus, Current: memory.ValidTo == nil && memory.Status == "active",
		Tags: memory.Tags, ValidFrom: memory.ValidFrom, ValidTo: memory.ValidTo, RecordedAt: memory.RecordedAt,
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
		Events:          h.AuditEvents,
		EventsTruncated: h.EventsTruncated,
		Lineage:         []historyMemory{},
		Edges:           []historyEdge{},
		Relationships:   []historyRelationship{},
		Truncated:       h.Lineage.Truncated || h.DirectRelationships.Truncated,
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
	if h.Lineage.Truncated || h.DirectRelationships.Truncated {
		parts = append(parts, partialPart{Part: "lineage", Reason: "truncated"})
	}
	if h.EventsTruncated {
		parts = append(parts, partialPart{Part: "events", Reason: "truncated"})
	}
	return parts
}
