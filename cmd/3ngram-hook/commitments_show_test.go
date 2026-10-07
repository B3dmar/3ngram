// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// Topics and rationales that live OUTSIDE the selector. Each test that plants
// them asserts none reaches stdout.
const (
	hiddenTopicProject   = "HIDDEN other-project topic"
	hiddenTopicScope     = "HIDDEN personal-scope topic"
	hiddenRationale      = "HIDDEN rationale naming a private memory"
	visibleTopicNewer    = "Newer decision in this project"
	visibleRationaleText = "Both ends are in demo"
)

var (
	commitmentID   = uuidFor("m", 50)
	insideNodeID   = uuidFor("m", 51)
	otherProjectID = uuidFor("m", 52)
	otherScopeID   = uuidFor("m", 53)
	newerID        = uuidFor("m", 54)
	partnerID      = uuidFor("m", 55)
	lookupID       = uuidFor("m", 56)
)

func historyNode(id, topic, scope string, project *string, current bool) map[string]any {
	return map[string]any{
		"id": id, "memoryType": "decision", "topic": topic, "project": project, "scope": scope,
		"status": "active", "validFrom": "2026-10-02T00:00:00.000Z", "validTo": nil,
		"recordedAt": "2026-10-02T00:00:00.000Z", "createdAt": "2026-10-02T00:00:00.000Z",
		"isCurrent": current, "lifecycleState": "current",
	}
}

func historyEdgeJSON(id, from, to, edgeType string) map[string]any {
	return map[string]any{"id": id, "fromId": from, "toId": to, "edgeType": edgeType, "createdBy": "user", "createdAt": "2026-10-03T00:00:00.000Z"}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// richHistory has, besides the commitment: one lineage node inside the
// selector and two outside it; edges between every combination; a newer
// successor inside the selector, and one outside it.
func richHistory() string {
	demo, other := strPtr("demo"), strPtr("other")
	return mustJSON(map[string]any{
		"memory": historyNode(commitmentID, "the commitment", "work", demo, true),
		"lineage": map[string]any{
			"nodes": []any{
				historyNode(commitmentID, "the commitment", "work", demo, true),
				historyNode(insideNodeID, "Earlier note in demo", "work", demo, false),
				historyNode(otherProjectID, hiddenTopicProject, "work", other, false),
				historyNode(otherScopeID, hiddenTopicScope, "personal", demo, false),
			},
			"edges": []any{
				historyEdgeJSON("e1", commitmentID, insideNodeID, "updates"),
				historyEdgeJSON("e2", commitmentID, otherProjectID, "updates"),
				historyEdgeJSON("e3", otherScopeID, commitmentID, "extends"),
			},
			"truncated": false,
		},
		"directRelationships": map[string]any{
			"predecessors": []any{map[string]any{"memory": historyNode(insideNodeID, "Earlier note in demo", "work", demo, false), "edge": historyEdgeJSON("e1", commitmentID, insideNodeID, "updates")}},
			"successors": []any{
				map[string]any{"memory": historyNode(newerID, visibleTopicNewer, "work", demo, true), "edge": historyEdgeJSON("e4", newerID, commitmentID, "updates")},
				map[string]any{"memory": historyNode(otherScopeID, hiddenTopicScope, "personal", demo, false), "edge": historyEdgeJSON("e3", otherScopeID, commitmentID, "extends")},
			},
			"truncated": false,
		},
		"auditEvents": []any{
			map[string]any{"id": "v1", "eventKind": "create", "actorKind": "user_mcp", "createdAt": "2026-10-01T00:00:00.000Z", "payloadMetadata": map[string]any{"present": true}},
		},
		"eventsTruncated": false,
		"sections":        map[string]any{"lineage": "ok", "events": "ok"},
	})
}

func proposalJSON(id, from, to, rationale string) map[string]any {
	return map[string]any{"id": id, "fromId": from, "toId": to, "edgeType": "updates", "memoryType": "commitment",
		"similarity": 0.91, "rationale": rationale, "status": "proposed", "decidedAt": nil, "createdAt": "2026-10-04T00:00:00.000Z"}
}

func showServer(t *testing.T, history string, proposals []any) *readServer {
	t.Helper()
	s := newReadServer(t)
	s.json("/api/v1/memories/"+commitmentID, 200, commitmentMemory("work", strPtr("demo")))
	s.json("/api/v1/memories/"+commitmentID+"/history", 200, history)
	s.json("/api/v1/proposals", 200, mustJSON(map[string]any{"proposals": proposals}))
	return s
}

func commitmentMemory(scope string, project *string) string {
	return mustJSON(map[string]any{
		"id": commitmentID, "memoryType": "commitment", "topic": "Ship the panel", "content": "Full commitment text",
		"scope": scope, "project": project, "status": "active", "commitmentStatus": "open", "tags": []string{"panel"},
		"validFrom": "2026-10-01T00:00:00.000Z", "validTo": nil,
		"recordedAt": "2026-10-01T00:00:00.000Z", "createdAt": "2026-10-01T00:00:00.000Z",
	})
}

func TestCommitmentsShowRedactsTheWholeResponse(t *testing.T) {
	s := showServer(t, richHistory(), []any{
		proposalJSON("p1", partnerID, commitmentID, visibleRationaleText),
		proposalJSON("p2", otherProjectID, commitmentID, hiddenRationale),
		proposalJSON("p3", lookupID, commitmentID, hiddenRationale),
		proposalJSON("p4", uuidFor("m", 90), uuidFor("m", 91), hiddenRationale),
	})
	s.json("/api/v1/memories/"+partnerID, 200, memoryBodyWithTopic(partnerID, "work", strPtr("demo"), "Proposed successor in demo"))
	s.json("/api/v1/memories/"+otherProjectID, 200, memoryBodyWithTopic(otherProjectID, "work", strPtr("other"), hiddenTopicProject))
	s.json("/api/v1/memories/"+lookupID, 200, memoryBodyWithTopic(lookupID, "personal", nil, hiddenTopicScope))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

	if r.code != 0 || !r.env.OK {
		t.Fatalf("code=%d env=%s", r.code, r.stdout)
	}
	for _, leak := range []string{hiddenTopicProject, hiddenTopicScope, hiddenRationale, otherProjectID, otherScopeID, lookupID} {
		if strings.Contains(r.stdout, leak) {
			t.Errorf("stdout leaks %q", leak)
		}
	}
	h := r.env.History
	if len(h.Lineage) != 1 || h.Lineage[0].ID != insideNodeID {
		t.Fatalf("lineage = %+v", h.Lineage)
	}
	if h.Hidden.Nodes != 2 || h.Hidden.Edges != 2 || h.Hidden.Relationships != 1 {
		t.Fatalf("hidden = %+v", h.Hidden)
	}
	if len(h.Edges) != 1 || h.Edges[0].ID != "e1" {
		t.Fatalf("an edge is shown only when both ends are: %+v", h.Edges)
	}
	ev := r.env.Evidence
	if ev.Verdict != verdictReview || ev.Hidden != 2 || ev.Unverified != 0 || len(ev.Items) != 2 {
		t.Fatalf("evidence = %+v", ev)
	}
	related, proposal := ev.Items[0], ev.Items[1]
	if related.Kind != evidenceRelatedMemory || related.MemoryID != newerID || related.Topic != visibleTopicNewer || related.Relation != "successor" {
		t.Fatalf("related = %+v", related)
	}
	if proposal.Kind != evidenceProposal || proposal.MemoryID != partnerID || proposal.Rationale == nil || *proposal.Rationale != visibleRationaleText {
		t.Fatalf("proposal = %+v", proposal)
	}
	if ev.Inspected.Proposals.Limit != 100 || ev.Inspected.Proposals.Returned != 4 || ev.Inspected.Proposals.PartnerLookups != 3 {
		t.Fatalf("window = %+v", ev.Inspected.Proposals)
	}
	if r.env.Source.CreatedBy == nil || *r.env.Source.CreatedBy != "user_mcp" || r.env.Source.Session != nil || r.env.Source.SessionReason != "not_exposed" {
		t.Fatalf("source = %+v", r.env.Source)
	}
	if c := r.env.Commitment; c.Content != "Full commitment text" || c.Filing != filingProject || !c.Current {
		t.Fatalf("commitment = %+v", c)
	}
}

// Membership is decided by the first request; a commitment outside the
// selector ends the read there, with nothing about it in the output.
func TestCommitmentsShowOutsideSelectorStopsAfterTheFirstRead(t *testing.T) {
	for name, memory := range map[string]string{
		"other project":    commitmentMemory("work", strPtr("other")),
		"other scope":      commitmentMemory("personal", strPtr("demo")),
		"unscoped, strict": commitmentMemory("work", nil),
	} {
		t.Run(name, func(t *testing.T) {
			s := newReadServer(t)
			s.json("/api/v1/memories/"+commitmentID, 200, memory)

			r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

			if r.code != 2 || r.env.Error.Kind != kindOutsideSelector {
				t.Fatalf("code=%d env=%s", r.code, r.stdout)
			}
			if n := len(s.recorded()); n != 1 {
				t.Fatalf("an outside commitment allows exactly one request, made %d", n)
			}
			if strings.Contains(r.stdout, "Ship the panel") || strings.Contains(r.stdout, "Full commitment text") {
				t.Fatalf("outside_selector leaked the record: %s", r.stdout)
			}
		})
	}
}

func TestCommitmentsShowUnscopedNeedsTheOptIn(t *testing.T) {
	s := showServer(t, richHistory(), []any{})
	s.json("/api/v1/memories/"+commitmentID, 200, commitmentMemory("work", nil))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work", "--include-unscoped")

	if !r.env.OK || r.env.Commitment.Filing != filingUnscoped {
		t.Fatalf("env = %s", r.stdout)
	}
}

func TestCommitmentsShowRefusesAChangedContextWithoutARequest(t *testing.T) {
	s := newReadServer(t)

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--expect-fingerprint", "0000000000000000")

	if r.code != 1 || r.env.Error.Kind != kindContextChanged || len(s.recorded()) != 0 {
		t.Fatalf("code=%d requests=%d env=%s", r.code, len(s.recorded()), r.stdout)
	}
}

func TestCommitmentsShowAcceptsTheCurrentFingerprint(t *testing.T) {
	showServer(t, richHistory(), []any{})
	dir := projectDir(t, "demo")
	probe := runCommitmentsForTest(t, dir, "context")

	r := runCommitmentsForTest(t, dir, "show", commitmentID, "--expect-fingerprint", probe.env.Context.Fingerprint)

	if !r.env.OK {
		t.Fatalf("env = %s", r.stdout)
	}
}

func TestCommitmentsShowRejectsAMalformedIDWithoutARequest(t *testing.T) {
	s := newReadServer(t)
	for _, args := range [][]string{{"show", ".."}, {"show", "."}, {"show"}, {"show", "--scope", "work"}} {
		r := runCommitmentsForTest(t, projectDir(t, "demo"), args...)
		if r.code != 1 || r.env.Error.Kind != kindUsage {
			t.Fatalf("%v: code=%d env=%s", args, r.code, r.stdout)
		}
	}
	if n := len(s.recorded()); n != 0 {
		t.Fatalf("a malformed id must make zero requests, made %d", n)
	}
}

func TestCommitmentsShowNoEvidenceSaysHowFarItLooked(t *testing.T) {
	empty := mustJSON(map[string]any{
		"memory":              historyNode(commitmentID, "the commitment", "work", strPtr("demo"), true),
		"lineage":             map[string]any{"nodes": []any{}, "edges": []any{}, "truncated": false},
		"directRelationships": map[string]any{"predecessors": []any{}, "successors": []any{}, "truncated": false},
		"auditEvents":         []any{},
		"eventsTruncated":     true,
		"sections":            map[string]any{"lineage": "ok", "events": "ok"},
	})
	showServer(t, empty, []any{})

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

	ev := r.env.Evidence
	if ev.Verdict != verdictNoneFound || len(ev.Items) != 0 {
		t.Fatalf("evidence = %+v", ev)
	}
	if ev.Inspected.Proposals == nil || ev.Inspected.Proposals.Limit != 100 || ev.Inspected.Proposals.MayHaveMore {
		t.Fatalf("window = %+v", ev.Inspected.Proposals)
	}
	if ev.Inspected.History == nil || ev.Inspected.History.EventCap != 50 || !ev.Inspected.History.EventsTruncated {
		t.Fatalf("history window = %+v", ev.Inspected.History)
	}
	if r.env.Source.CreatedBy != nil {
		t.Fatal("with the create event out of the window, the creator is unknown, not guessed")
	}
	if !hasPartial(r.env, "events", "truncated") {
		t.Fatalf("partial = %+v", r.env.Partial)
	}
}

func TestCommitmentsShowFullProposalWindowMayHaveMore(t *testing.T) {
	proposals := make([]any, 0, 100)
	for i := 0; i < 100; i++ {
		proposals = append(proposals, proposalJSON("p", uuidFor("m", 100+i), uuidFor("m", 300+i), "x"))
	}
	showServer(t, richHistory(), proposals)

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

	if !r.env.Evidence.Inspected.Proposals.MayHaveMore || !hasPartial(r.env, "proposals", "window") {
		t.Fatalf("a full window must say more may exist: %s", r.stdout)
	}
}

func TestCommitmentsShowDegradesPartByPart(t *testing.T) {
	t.Run("history unavailable", func(t *testing.T) {
		s := showServer(t, "", []any{proposalJSON("p1", newerID, commitmentID, "r")})
		s.json("/api/v1/memories/"+commitmentID+"/history", 503, `{"error":"unavailable"}`)
		s.json("/api/v1/memories/"+newerID, 200, memoryBodyWithTopic(newerID, "work", strPtr("demo"), visibleTopicNewer))

		r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

		if !r.env.OK || r.env.History != nil || r.env.Evidence.Inspected.History != nil || !hasPartial(r.env, "history", kindUnavailable) {
			t.Fatalf("env = %s", r.stdout)
		}
		if len(r.env.Evidence.Items) != 1 {
			t.Fatalf("proposals still count without history: %+v", r.env.Evidence)
		}
	})
	t.Run("proposals unavailable", func(t *testing.T) {
		s := showServer(t, richHistory(), nil)
		s.json("/api/v1/proposals", 503, `{"error":"unavailable"}`)

		r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

		if !r.env.OK || r.env.Evidence.Inspected.Proposals != nil || !hasPartial(r.env, "proposals", kindUnavailable) {
			t.Fatalf("env = %s", r.stdout)
		}
	})
	t.Run("history section unavailable", func(t *testing.T) {
		degraded := strings.Replace(richHistory(), `"lineage":"ok"`, `"lineage":"unavailable"`, 1)
		showServer(t, degraded, []any{})

		r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

		if !hasPartial(r.env, "lineage", kindUnavailable) {
			t.Fatalf("partial = %+v", r.env.Partial)
		}
	})
	t.Run("partner lookups capped", func(t *testing.T) {
		var proposals []any
		for i := 0; i < 5; i++ {
			proposals = append(proposals, proposalJSON("p", uuidFor("m", 200+i), commitmentID, hiddenRationale))
		}
		s := showServer(t, richHistory(), proposals)
		for i := 0; i < 5; i++ {
			s.json("/api/v1/memories/"+uuidFor("m", 200+i), 200, memoryBodyWithTopic(uuidFor("m", 200+i), "work", strPtr("demo"), "partner"))
		}

		r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

		lookups := 0
		for i := 0; i < 5; i++ {
			lookups += s.count("/api/v1/memories/" + uuidFor("m", 200+i))
		}
		if lookups != maxProposalPartnerLookups || len(r.env.Evidence.Items) != 1+maxProposalPartnerLookups || r.env.Evidence.Hidden != 0 || r.env.Evidence.Unverified != 2 {
			t.Fatalf("lookups=%d evidence=%+v", lookups, r.env.Evidence)
		}
		if !strings.Contains(r.stdout, `"part":"proposal_partners","reason":"lookup_cap","returned":3,"total":5`) {
			t.Fatalf("the cap must be labelled: %s", r.stdout)
		}
	})
}

// An uppercase id is found by the server (uuid matching ignores case), so it
// must be normalised before it is compared with the lowercase ids the history
// and proposals carry; otherwise every comparison misses and the verdict is a
// false none_found.
func TestCommitmentsShowNormalisesTheIDCase(t *testing.T) {
	s := showServer(t, richHistory(), []any{proposalJSON("p1", partnerID, commitmentID, visibleRationaleText)})
	s.json("/api/v1/memories/"+partnerID, 200, memoryBodyWithTopic(partnerID, "work", strPtr("demo"), "partner"))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", strings.ToUpper(commitmentID), "--scope", "work")

	if !r.env.OK || r.env.Evidence.Verdict != verdictReview || len(r.env.Evidence.Items) != 2 {
		t.Fatalf("env = %s", r.stdout)
	}
	for _, node := range r.env.History.Lineage {
		if node.ID == commitmentID {
			t.Fatal("the commitment must not appear in its own lineage")
		}
	}
}

func TestCommitmentsShowRejectsAnAnswerForAnotherID(t *testing.T) {
	s := newReadServer(t)
	s.json("/api/v1/memories/"+commitmentID, 200, strings.Replace(commitmentMemory("work", strPtr("demo")), commitmentID, partnerID, 1))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

	if r.code != 2 || r.env.Error.Kind != kindBadResponse || len(s.recorded()) != 1 {
		t.Fatalf("code=%d env=%s", r.code, r.stdout)
	}
}

func TestCommitmentsShowProjectSelector(t *testing.T) {
	decision := strings.Replace(commitmentMemory("work", strPtr("demo")), `"memoryType":"commitment"`, `"memoryType":"decision"`, 1)
	for name, tc := range map[string]struct {
		memory string
		ok     bool
	}{
		"same project, any scope": {commitmentMemory("personal", strPtr("demo")), true},
		"no project":              {commitmentMemory("work", nil), false},
		"other project":           {commitmentMemory("work", strPtr("other")), false},
		"not a commitment":        {decision, false},
	} {
		t.Run(name, func(t *testing.T) {
			s := showServer(t, richHistory(), []any{})
			s.json("/api/v1/memories/"+commitmentID, 200, tc.memory)

			r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID)

			if r.env.OK != tc.ok {
				t.Fatalf("ok=%v env=%s", r.env.OK, r.stdout)
			}
			if !tc.ok && (r.env.Error.Kind != kindOutsideSelector || len(s.recorded()) != 1) {
				t.Fatalf("env=%s requests=%d", r.stdout, len(s.recorded()))
			}
		})
	}
}

func TestCommitmentsShowCountsAFailedPartnerAsUnverified(t *testing.T) {
	s := showServer(t, richHistory(), []any{
		proposalJSON("p1", partnerID, commitmentID, hiddenRationale),
		proposalJSON("p2", commitmentID, commitmentID, "self"),
	})
	s.json("/api/v1/memories/"+partnerID, 503, `{"error":"unavailable"}`)

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

	ev := r.env.Evidence
	if ev.Hidden != 0 || ev.Unverified != 1 || strings.Contains(r.stdout, hiddenRationale) {
		t.Fatalf("evidence = %+v", ev)
	}
	for _, it := range ev.Items {
		if it.Kind == evidenceProposal {
			t.Fatalf("neither an unverified nor a self proposal is evidence: %+v", it)
		}
	}
	if !hasPartial(r.env, "proposal_partners", kindUnavailable) {
		t.Fatalf("partial = %+v", r.env.Partial)
	}
}

func TestCommitmentsShowNoneFoundWithoutHistoryIsLabelled(t *testing.T) {
	s := showServer(t, "", []any{})
	s.json("/api/v1/memories/"+commitmentID+"/history", 503, `{"error":"unavailable"}`)

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

	ev := r.env.Evidence
	if ev.Verdict != verdictNoneFound || ev.Inspected.History != nil || ev.Inspected.Proposals == nil || !hasPartial(r.env, "history", kindUnavailable) {
		t.Fatalf("a none_found without history must show history was not inspected: %s", r.stdout)
	}
}

// A partner read answered for another id must not lend that row's filing to
// the partner: the proposal stays unverified and shows nothing.
func TestCommitmentsShowPartnerAnsweredForAnotherID(t *testing.T) {
	s := showServer(t, richHistory(), []any{proposalJSON("p1", partnerID, commitmentID, hiddenRationale)})
	s.json("/api/v1/memories/"+partnerID, 200, memoryBodyWithTopic(insideNodeID, "work", strPtr("demo"), "borrowed"))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

	if r.env.Evidence.Unverified != 1 || strings.Contains(r.stdout, hiddenRationale) || strings.Contains(r.stdout, "borrowed") {
		t.Fatalf("env = %s", r.stdout)
	}
}

// derives says one memory was derived from another; it is not evidence that a
// commitment is done, from the history or from a proposal.
func TestCommitmentsShowIgnoresDerivesEdges(t *testing.T) {
	history := strings.Replace(richHistory(), `"edgeType":"updates","fromId":"`+newerID, `"edgeType":"derives","fromId":"`+newerID, 1)
	if history == richHistory() {
		t.Fatal("fixture edit did not apply")
	}
	derived := proposalJSON("p1", partnerID, commitmentID, "derived")
	derived["edgeType"] = "derives"
	s := showServer(t, history, []any{derived})
	s.json("/api/v1/memories/"+partnerID, 200, memoryBodyWithTopic(partnerID, "work", strPtr("demo"), "partner"))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

	if r.env.Evidence.Verdict != verdictNoneFound || len(r.env.Evidence.Items) != 0 {
		t.Fatalf("derives edges must not be evidence: %+v", r.env.Evidence)
	}
}

func TestCommitmentsShowReportsRelationshipTruncationApart(t *testing.T) {
	history := strings.Replace(richHistory(), `"truncated":false},"eventsTruncated"`, `"truncated":true},"eventsTruncated"`, 1)
	if history == richHistory() {
		t.Fatal("fixture edit did not apply")
	}
	showServer(t, history, []any{})

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

	w := r.env.Evidence.Inspected.History
	if w == nil || !w.RelationshipsTruncated || w.LineageTruncated || w.RelationshipCap != 50 {
		t.Fatalf("window = %+v", w)
	}
	if !hasPartial(r.env, "relationships", "truncated") || hasPartial(r.env, "lineage", "truncated") {
		t.Fatalf("partial = %+v", r.env.Partial)
	}
}

func TestCommitmentsShowNilTagsAreAnEmptyList(t *testing.T) {
	s := showServer(t, richHistory(), []any{})
	s.json("/api/v1/memories/"+commitmentID, 200, strings.Replace(commitmentMemory("work", strPtr("demo")), `"tags":["panel"]`, `"tags":null`, 1))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

	if !strings.Contains(r.stdout, `"tags":[]`) {
		t.Fatalf("stdout = %s", r.stdout)
	}
}

// The history answer must be for the requested memory, or it says nothing
// about this commitment.
func TestCommitmentsShowRejectsHistoryForAnotherMemory(t *testing.T) {
	other := strings.Replace(richHistory(), `"memory":{"createdAt":"2026-10-02T00:00:00.000Z","id":"`+commitmentID, `"memory":{"createdAt":"2026-10-02T00:00:00.000Z","id":"`+partnerID, 1)
	if other == richHistory() {
		t.Fatal("fixture edit did not apply")
	}
	showServer(t, other, []any{})

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

	if !r.env.OK || r.env.History != nil || !hasPartial(r.env, "history", kindBadResponse) {
		t.Fatalf("env = %s", r.stdout)
	}
	if strings.Contains(r.stdout, visibleTopicNewer) {
		t.Fatal("evidence from another memory's history must not be shown")
	}
}

// A degraded history (lineage unavailable) comes back as 200 with empty lists;
// that is not an inspected window, so it is not reported as one.
func TestCommitmentsShowUnavailableLineageIsNotAnInspectedWindow(t *testing.T) {
	degraded := strings.Replace(richHistory(), `"lineage":"ok"`, `"lineage":"unavailable"`, 1)
	showServer(t, degraded, []any{})

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

	if r.env.Evidence.Inspected.History != nil || !hasPartial(r.env, "lineage", kindUnavailable) {
		t.Fatalf("env = %s", r.stdout)
	}
}

func TestCommitmentsShowRejectsAProposalsAnswerWithoutTheList(t *testing.T) {
	s := showServer(t, richHistory(), []any{})
	s.json("/api/v1/proposals", 200, `{"error":"proxied"}`)

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work")

	if r.env.Evidence.Inspected.Proposals != nil || !hasPartial(r.env, "proposals", kindBadResponse) {
		t.Fatalf("env = %s", r.stdout)
	}
}

// An answer that omits a memory's project is not an unscoped memory: with
// unscoped records included, it is still outside the selector.
func TestCommitmentsShowOmittedProjectIsOutside(t *testing.T) {
	s := showServer(t, richHistory(), []any{})
	var body map[string]any
	_ = json.Unmarshal([]byte(commitmentMemory("work", nil)), &body)
	delete(body, "project")
	s.json("/api/v1/memories/"+commitmentID, 200, mustJSON(body))

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID, "--scope", "work", "--include-unscoped")

	if r.code != 2 || r.env.Error.Kind != kindOutsideSelector || strings.Contains(r.stdout, "Full commitment text") {
		t.Fatalf("env = %s", r.stdout)
	}
}

func TestCommitmentsShowNotFound(t *testing.T) {
	s := newReadServer(t)
	s.json("/api/v1/memories/"+commitmentID, http.StatusNotFound, `{"error":"not_found"}`)

	r := runCommitmentsForTest(t, projectDir(t, "demo"), "show", commitmentID)

	if r.code != 2 || r.env.Error.Kind != kindNotFound || len(s.recorded()) != 1 {
		t.Fatalf("code=%d env=%s", r.code, r.stdout)
	}
}

func memoryBodyWithTopic(id, scope string, project *string, topic string) string {
	return mustJSON(map[string]any{
		"id": id, "memoryType": "decision", "topic": topic, "content": "partner content",
		"scope": scope, "project": project, "status": "active", "tags": []string{},
		"validFrom": "2026-10-01T00:00:00.000Z", "validTo": nil,
		"recordedAt": "2026-10-01T00:00:00.000Z", "createdAt": "2026-10-01T00:00:00.000Z",
	})
}
