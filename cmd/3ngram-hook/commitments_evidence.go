// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"io"
	"strconv"
	"strings"
)

// Evidence is what the detail view offers for REVIEW, never a resolution: the
// panel changes no record, and a newer linked memory or a pending proposal is
// related evidence, not proof the commitment is done. When nothing is found
// the verdict is `none_found` and the envelope says exactly how far it looked,
// because a bounded, tenant-wide proposals window cannot establish that no
// evidence exists.

// maxProposalPartnerLookups bounds the extra memory reads that decide whether
// a proposal's other end is inside the selector.
const maxProposalPartnerLookups = 3

// Proposals is a pointer so an answer without the list is told apart from an
// empty one.
type proposalsResponse struct {
	Proposals *[]proposalRow `json:"proposals"`
}

type proposalRow struct {
	ID         string  `json:"id"`
	FromID     string  `json:"fromId"`
	ToID       string  `json:"toId"`
	EdgeType   string  `json:"edgeType"`
	MemoryType string  `json:"memoryType"`
	Similarity float64 `json:"similarity"`
	Rationale  *string `json:"rationale"`
	Status     string  `json:"status"`
}

// evidenceItem is one piece of related evidence. Fields about another memory
// are only ever set when that memory is inside the selector. Relation is the
// OTHER memory's place in the (proposed) edge relative to the commitment:
// `successor` is newer and updates, extends or supersedes it; `predecessor` is
// what the commitment would update.
type evidenceItem struct {
	Kind       string   `json:"kind"`
	Source     string   `json:"source"`
	EdgeType   string   `json:"edgeType"`
	Relation   string   `json:"relation"`
	MemoryID   string   `json:"memoryId"`
	MemoryType string   `json:"memoryType,omitempty"`
	Topic      string   `json:"topic,omitempty"`
	RecordedAt string   `json:"recordedAt,omitempty"`
	Current    *bool    `json:"current,omitempty"`
	ProposalID string   `json:"proposalId,omitempty"`
	Similarity *float64 `json:"similarity,omitempty"`
	Rationale  *string  `json:"rationale,omitempty"`
}

const (
	evidenceRelatedMemory = "related_memory"
	evidenceProposal      = "consolidation_proposal"
	verdictReview         = "review"
	verdictNoneFound      = "none_found"
)

// commitmentEvidence counts what it could not show in two ways: Hidden is
// proposals whose other end was verified OUTSIDE the selector, Unverified is
// proposals whose other end could not be checked (lookup cap or failure).
// Neither contributes anything but the count.
type commitmentEvidence struct {
	Verdict    string         `json:"verdict"`
	Items      []evidenceItem `json:"items"`
	Inspected  evidenceWindow `json:"inspected"`
	Hidden     int            `json:"hiddenOutsideSelector"`
	Unverified int            `json:"unverifiedPartners"`
	// GitHub is set with --github: the references the commitment names.
	GitHub  []githubEvidence `json:"github,omitempty"`
	partial []partialPart
}

// decideVerdict is `review` when there is evidence that could explain a
// resolution: a 3ngram item, or a referenced issue or pull request that is
// closed or merged. Open references are listed as context and change nothing.
func (ev *commitmentEvidence) decideVerdict() {
	ev.Verdict = verdictNoneFound
	if len(ev.Items) > 0 {
		ev.Verdict = verdictReview
		return
	}
	for _, g := range ev.GitHub {
		if g.signalsResolution() {
			ev.Verdict = verdictReview
			return
		}
	}
}

// evidenceWindow is how far the evidence search looked. A nil part was not
// inspected at all (its read failed), which `partial` also says.
type evidenceWindow struct {
	Proposals *proposalWindow `json:"proposals"`
	History   *historyWindow  `json:"history"`
	GitHub    *githubWindow   `json:"github,omitempty"`
}

type proposalWindow struct {
	Status         string `json:"status"`
	Order          string `json:"order"`
	Limit          int    `json:"limit"`
	Returned       int    `json:"returned"`
	MayHaveMore    bool   `json:"mayHaveMore"`
	PartnerLookups int    `json:"partnerLookups"`
}

// historyWindow is how far the history search looked. Evidence comes from the
// direct relationships, which the server caps on their own, so their cap and
// truncation are reported apart from the lineage's.
type historyWindow struct {
	LineageNodeCap         int  `json:"lineageNodeCap"`
	RelationshipCap        int  `json:"relationshipCap"`
	EventCap               int  `json:"eventCap"`
	LineageTruncated       bool `json:"lineageTruncated"`
	RelationshipsTruncated bool `json:"relationshipsTruncated"`
	EventsTruncated        bool `json:"eventsTruncated"`
}

func proposalsQuery() string {
	return "/api/v1/proposals?limit=" + strconv.Itoa(maxRestProposalsLimit) + "&status=proposed"
}

// collectEvidence gathers related evidence from the redacted history and from
// pending proposals touching the commitment.
func collectEvidence(ctx context.Context, cfg readConfig, memoryID string, sel briefingSelector, history *commitmentHistory,
	visible map[string]bool, proposals proposalsResponse, proposalsErr *readError, stderr io.Writer) *commitmentEvidence {
	ev := &commitmentEvidence{Items: []evidenceItem{}}
	// Only a lineage the server actually read is an inspected window.
	if history != nil && history.lineageOK {
		ev.Inspected.History = &historyWindow{
			LineageNodeCap: historyLineageNodeCap, RelationshipCap: historyRelationshipCap, EventCap: historyEventCap,
			LineageTruncated: history.LineageTruncated, RelationshipsTruncated: history.RelationshipsTruncated,
			EventsTruncated: history.EventsTruncated,
		}
		ev.Items = append(ev.Items, evidenceFromHistory(memoryID, history)...)
	}
	if proposalsErr != nil {
		logReadFailure(stderr, proposalsErr)
		ev.partial = append(ev.partial, partialPart{Part: "proposals", Reason: proposalsErr.Kind})
	} else {
		items, hidden, unverified, window, partial := evidenceFromProposals(ctx, cfg, memoryID, sel, history, visible, proposals)
		ev.Items = append(ev.Items, items...)
		ev.Hidden += hidden
		ev.Unverified += unverified
		ev.Inspected.Proposals = &window
		ev.partial = append(ev.partial, partial...)
	}
	ev.decideVerdict()
	return ev
}

// evidenceEdgeTypes are the edges that can bear on whether a commitment is
// done: a newer memory that updates, extends or supersedes it. `derives` only
// says one memory was derived from another, and is not evidence.
var evidenceEdgeTypes = map[string]bool{"updates": true, "extends": true, "supersedes": true}

// evidenceFromHistory turns each visible successor of the commitment, linked
// by an evidence edge type, into evidence: a memory whose edge points at the
// commitment (successor -> predecessor), so it was written later and
// updates, extends or supersedes it. Predecessors are what the commitment came
// from and say nothing about completion.
func evidenceFromHistory(memoryID string, history *commitmentHistory) []evidenceItem {
	var items []evidenceItem
	for _, rel := range history.Relationships {
		if rel.Edge.ToID != memoryID || !evidenceEdgeTypes[rel.Edge.EdgeType] {
			continue
		}
		current := rel.Memory.IsCurrent
		items = append(items, evidenceItem{
			Kind: evidenceRelatedMemory, Source: "3ngram", EdgeType: rel.Edge.EdgeType, Relation: "successor",
			MemoryID: rel.Memory.ID, MemoryType: rel.Memory.MemoryType, Topic: rel.Memory.Topic,
			RecordedAt: rel.Memory.RecordedAt, Current: &current,
		})
	}
	return items
}

// evidenceFromProposals keeps the pending proposals that touch the commitment
// and whose other end is verified inside the selector. A partner the history
// already showed is known; any other is read back, at most
// maxProposalPartnerLookups of them. A partner outside the selector, or one
// that could not be verified, is counted as hidden and contributes nothing: no
// id, no topic, no rationale.
func evidenceFromProposals(ctx context.Context, cfg readConfig, memoryID string, sel briefingSelector, history *commitmentHistory,
	visible map[string]bool, resp proposalsResponse) ([]evidenceItem, int, int, proposalWindow, []partialPart) {
	window := proposalWindow{
		Status: "proposed", Order: "newest_first", Limit: maxRestProposalsLimit,
		Returned: len(*resp.Proposals), MayHaveMore: len(*resp.Proposals) >= maxRestProposalsLimit,
	}
	known := knownTopics(history)
	var touching []proposalRow
	var unknownPartners []string
	seen := map[string]bool{}
	for _, p := range *resp.Proposals {
		if (p.FromID != memoryID && p.ToID != memoryID) || !evidenceEdgeTypes[p.EdgeType] {
			continue
		}
		other := proposalPartner(p, memoryID)
		if other == memoryID {
			continue // a self-proposal says nothing
		}
		touching = append(touching, p)
		if !visible[other] && !seen[other] {
			seen[other] = true
			unknownPartners = append(unknownPartners, other)
		}
	}

	lookups := unknownPartners
	if len(lookups) > maxProposalPartnerLookups {
		lookups = lookups[:maxProposalPartnerLookups]
	}
	window.PartnerLookups = len(lookups)
	verdicts := make([]partnerVerdict, len(lookups))
	forEachBounded(ctx, len(lookups), readConcurrency, func(ctx context.Context, n int) {
		verdicts[n] = lookupPartner(ctx, cfg, lookups[n], sel)
	})
	inside, outside := map[string]bool{}, map[string]bool{}
	unverified, failedKind := len(unknownPartners)-len(lookups), ""
	for n, id := range lookups {
		switch v := verdicts[n]; {
		case !v.done:
			unverified++
			if failedKind == "" {
				failedKind = classifyReadFailure(ctx, "memory", 0, nil).Kind
			}
		case v.err != nil:
			unverified++
			if failedKind == "" {
				failedKind = v.err.Kind
			}
		case v.inside:
			inside[id] = true
			known[id] = v.topic
		default:
			outside[id] = true
		}
	}

	var items []evidenceItem
	hidden, unverifiedProposals := 0, 0
	for _, p := range touching {
		other := proposalPartner(p, memoryID)
		if !visible[other] && !inside[other] {
			if outside[other] {
				hidden++
			} else {
				unverifiedProposals++
			}
			continue
		}
		similarity := p.Similarity
		relation := "predecessor"
		if p.ToID == memoryID {
			relation = "successor"
		}
		items = append(items, evidenceItem{
			Kind: evidenceProposal, Source: "3ngram", EdgeType: p.EdgeType, Relation: relation,
			MemoryID: other, Topic: known[other], ProposalID: p.ID, Similarity: &similarity, Rationale: p.Rationale,
		})
	}

	var partial []partialPart
	if window.MayHaveMore {
		partial = append(partial, countedPart("proposals", "window", window.Returned, window.Limit))
	}
	if unverified > 0 {
		reason := "lookup_cap"
		if failedKind != "" {
			reason = failedKind
		}
		partial = append(partial, countedPart("proposal_partners", reason, len(unknownPartners)-unverified, len(unknownPartners)))
	}
	return items, hidden, unverifiedProposals, window, partial
}

func proposalPartner(p proposalRow, memoryID string) string {
	if p.FromID == memoryID {
		return p.ToID
	}
	return p.FromID
}

// knownTopics indexes the topics of the visible memories the history showed.
func knownTopics(history *commitmentHistory) map[string]string {
	known := map[string]string{}
	if history == nil {
		return known
	}
	for _, node := range history.Lineage {
		known[node.ID] = node.Topic
	}
	for _, rel := range history.Relationships {
		known[rel.Memory.ID] = rel.Memory.Topic
	}
	return known
}

type partnerVerdict struct {
	done   bool
	inside bool
	topic  string
	err    *readError
}

func lookupPartner(ctx context.Context, cfg readConfig, memoryID string, sel briefingSelector) partnerVerdict {
	path, ok := memoryPath(memoryID, "")
	if !ok {
		return partnerVerdict{done: true, err: &readError{Kind: kindBadResponse, Route: "memory"}}
	}
	var m memoryDetail
	if err := apiGet(ctx, cfg, "memory", path, &m); err != nil {
		return partnerVerdict{done: true, err: err}
	}
	// A body for another id says nothing about this partner, and a body that
	// does not state the partner's filing cannot place it outside the
	// selector either: both leave it unverified rather than hidden.
	if !strings.EqualFold(m.ID, memoryID) || !statesFiling(m.Scope, m.Project) {
		return partnerVerdict{done: true, err: &readError{Kind: kindBadResponse, Route: "memory"}}
	}
	in, _ := memoryInSelector(m.Scope, m.Project, sel)
	if !in {
		return partnerVerdict{done: true}
	}
	return partnerVerdict{done: true, inside: true, topic: m.Topic}
}
