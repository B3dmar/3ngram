// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// dashboardResponse / dashboardItem are the precheck read shape. The PreToolUse
// surfacing path reuses the REST search envelope's id/topic/memory_type/content
// fields; the topic-prefix narrowing is applied client-side against the file
// stem about to be edited.
type dashboardResponse struct {
	Items []dashboardItem `json:"items"`
	Total int             `json:"total"`
}

type dashboardItem struct {
	ID         int    `json:"id"`
	Topic      string `json:"topic"`
	Content    string `json:"content"`
	MemoryType string `json:"memory_type"`
	AlertType  string `json:"alert_type"`
}

// searchEnvelope mirrors POST /api/v1/search's response (router.ts): a flat list
// of hits plus a count. The precheck path maps it onto dashboardItem so the
// renderer stays unchanged.
type searchEnvelope struct {
	Hits []struct {
		ID         string `json:"id"`
		MemoryType string `json:"memoryType"`
		Topic      string `json:"topic"`
		Content    string `json:"content"`
	} `json:"hits"`
	Count int `json:"count"`
}

// PreToolUse hook input shape — mirrors the bash precheck contract. tool_input
// is kept raw because its JSON shape varies by client: Claude Code and Codex's
// structured apply_patch send an OBJECT, while Codex's freeform apply_patch tool
// sends the patch as a bare STRING. parseToolInput normalizes both.
type precheckInput struct {
	ToolName  string          `json:"tool_name"`
	ToolInput json.RawMessage `json:"tool_input"`
}

type precheckToolIn struct {
	FilePath string `json:"file_path"`
	Command  string `json:"command"`
}

// Only surface memories before file edits, not for every Bash/Read call.
var precheckMatchingTools = map[string]struct{}{
	"Edit":         {},
	"Write":        {},
	"NotebookEdit": {},
	"apply_patch":  {},
}

// runPrecheck is the PreToolUse hook. It surfaces 3ngram memories related to the
// file stem about to be edited via POST /api/v1/search. Pure context — never
// blocks the tool call. Stays silent on every failure path and exits 0 within a
// tight 500ms budget.
func runPrecheck() int {
	if os.Getenv("THREENGRAM_PRECHECK_DISABLE") == "1" {
		return 0
	}

	var input precheckInput
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		return 0
	}

	if _, ok := precheckMatchingTools[input.ToolName]; !ok {
		return 0
	}

	stem, ok := precheckStem(input.ToolName, input.ToolInput)
	if !ok {
		return 0
	}

	if apiKey() == "" {
		return 0
	}

	limit := envInt("THREENGRAM_PRECHECK_LIMIT", 3)
	if limit <= 0 {
		limit = 3
	}

	resp, ok := precheckSearch(stem, limit)
	if !ok {
		return 0
	}

	output, err := renderPrecheckHookOutput(renderPrecheck(resp, stem, limit))
	if err != nil {
		return 0
	}
	fmt.Println(output)
	return 0
}

// precheckStem resolves the topic stem for a matching PreToolUse call. It
// handles Claude's tool_input.file_path, Codex's structured apply_patch
// (tool_input.command), and Codex's freeform apply_patch (tool_input is the raw
// patch string). For patches it scans EVERY touched file and returns the first
// eligible stem, so an ineligible leading header (a repo-root file or dotfile)
// does not suppress a later edit to a nested source file.
func precheckStem(toolName string, raw json.RawMessage) (string, bool) {
	filePath, command := parseToolInput(raw)
	if filePath != "" {
		return precheckTopicStem(filePath)
	}
	if toolName == "apply_patch" {
		for _, path := range precheckPatchFilePaths(command) {
			if stem, ok := precheckTopicStem(path); ok {
				return stem, true
			}
		}
	}
	return "", false
}

// parseToolInput normalizes a PreToolUse tool_input that arrives either as an
// object ({"file_path":…,"command":…} — Claude Code and Codex's structured
// apply_patch) or as the bare patch STRING (Codex's freeform apply_patch tool).
// A raw string is returned as the command so the patch parser can extract the
// file; decoding into a struct alone would fail on the string shape and drop the
// hook silently for every real freeform Codex patch.
func parseToolInput(raw json.RawMessage) (filePath, command string) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return "", ""
	}
	if trimmed[0] == '"' {
		var patch string
		if err := json.Unmarshal(trimmed, &patch); err == nil {
			return "", patch
		}
		return "", ""
	}
	var obj precheckToolIn
	if err := json.Unmarshal(trimmed, &obj); err == nil {
		return obj.FilePath, obj.Command
	}
	return "", ""
}

// precheckPatchFilePaths returns every file touched by a Codex apply_patch
// payload, in patch order. Codex exposes the raw patch under tool_input.command
// (structured) or as the tool_input string itself (freeform) rather than the
// Claude-style tool_input.file_path field.
func precheckPatchFilePaths(command string) []string {
	prefixes := []string{"*** Update File: ", "*** Add File: ", "*** Delete File: "}
	var paths []string
	for _, line := range strings.Split(command, "\n") {
		line = strings.TrimSpace(line)
		for _, prefix := range prefixes {
			if path, ok := strings.CutPrefix(line, prefix); ok {
				paths = append(paths, strings.TrimSpace(path))
			}
		}
	}
	return paths
}

// renderPrecheckHookOutput emits the shared Claude/Codex hook JSON shape.
// Codex intentionally ignores plain stdout from PreToolUse hooks, while
// additionalContext is injected into the model context by both clients.
func renderPrecheckHookOutput(context string) (string, error) {
	payload := map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":     "PreToolUse",
			"additionalContext": context,
		},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// precheckSearch queries POST /api/v1/search for memories whose topic relates to
// the file stem and maps the REST envelope onto the dashboardResponse the
// renderer consumes. ok is false on any failure, timeout, 4xx, or empty result —
// callers must stay silent in those cases (the precheck never blocks).
func precheckSearch(stem string, limit int) (dashboardResponse, bool) {
	project := precheckProjectName()

	reqBody, err := json.Marshal(map[string]any{
		"query":   stem,
		"limit":   limit,
		"project": project,
	})
	if err != nil {
		return dashboardResponse{}, false
	}

	body, status, err := apiRequest("POST", "/api/v1/search", reqBody, 500*time.Millisecond)
	if err != nil || status >= 400 {
		return dashboardResponse{}, false
	}
	debugDumpPrecheck(body)

	var env searchEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return dashboardResponse{}, false
	}
	if env.Count == 0 || len(env.Hits) == 0 {
		return dashboardResponse{}, false
	}

	resp := dashboardResponse{Total: env.Count}
	for _, h := range env.Hits {
		resp.Items = append(resp.Items, dashboardItem{
			Topic:      h.Topic,
			Content:    h.Content,
			MemoryType: h.MemoryType,
		})
	}
	return resp, true
}

// precheckTopicStem returns the filename without extension, or false for
// paths the bash script intentionally skipped (root files, dotfiles).
func precheckTopicStem(filePath string) (string, bool) {
	dir := filepath.Base(filepath.Dir(filePath))
	base := filepath.Base(filePath)
	if base == "" || dir == "" || dir == "." {
		return "", false
	}
	if strings.HasPrefix(base, ".") {
		return "", false
	}
	stem := base
	if ext := filepath.Ext(base); ext != "" {
		stem = strings.TrimSuffix(base, ext)
	}
	if stem == "" {
		return "", false
	}
	return stem, true
}

// precheckProjectName derives the project the SAME way the rest of the hook does
// (deriveProject in project.go: repo-root/origin-based), so a precheck launched
// from a subdirectory resolves to the repo-root project and AGREES with the
// capture path — a raw filepath.Base(cwd) would yield the subdir name instead.
func precheckProjectName() string {
	cwd, err := os.Getwd()
	if err != nil {
		return ""
	}
	return deriveProject(cwd)
}

func renderPrecheck(resp dashboardResponse, stem string, limit int) string {
	noun := "memories"
	if resp.Total == 1 {
		noun = "memory"
	}
	var out strings.Builder
	fmt.Fprintf(&out, "3ngram: %d %s with topic starting `%s`:\n", resp.Total, noun, stem)

	n := len(resp.Items)
	if n > limit {
		n = limit
	}
	for _, item := range resp.Items[:n] {
		line := fmt.Sprintf("- [%d] **%s**", item.ID, item.Topic)
		if item.MemoryType != "" {
			line += fmt.Sprintf(" (%s)", item.MemoryType)
		}
		content := item.Content
		if len(content) > 160 {
			content = content[:160]
		}
		if content != "" {
			line += ": " + content
		}
		out.WriteString(line)
		out.WriteString("\n")
	}
	return out.String()
}

func debugDumpPrecheck(body []byte) {
	if os.Getenv("THREENGRAM_HOOK_DEBUG") != "1" {
		return
	}
	dir := debugDir
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	name := fmt.Sprintf("precheck-%s.json", strconv.FormatInt(time.Now().UnixNano(), 10))
	_ = os.WriteFile(filepath.Join(dir, name), body, 0o644)
}
