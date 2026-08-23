# 3ngram-hook

Static, zero-dependency Go binary that integrates Claude Code and Codex with the 3ngram
REST API (`/api/v1`). It replaces forked bash hook scripts — fetching a session
briefing and surfacing relevant memories before file edits — all fire-and-forget
so a hook never blocks your workflow.

Built for the 3ngram backend:
the briefing reads the single `GET /api/v1/briefing` orientation endpoint and the
precheck surfaces memories via `POST /api/v1/search`. The binary is a read-side
context feed plus session BOOKKEEPING (`agent_sessions` open / heartbeat /
close — no memory rows, ever); high-value write capture (LLM-summarized
decisions/commitments) is handled by the `/debrief` skill, not a mechanical hook.

## Subcommands

| Command | Hook Event | Description |
|---------|-----------|-------------|
| `3ngram-hook briefing` | SessionStart | Fetch `GET /api/v1/briefing?mode=full`, render + locally truncate the markdown briefing, open/refresh the session row, and inject the `sessionRunId` |
| `3ngram-hook heartbeat` | Stop | Refresh the session lease and snapshot a bounded `last_assistant_message` (`POST /api/v1/agent-sessions/heartbeat`). Never blocks, never prints, always exits 0 |
| `3ngram-hook close` | SessionEnd | Stamp `closed_at` by natural key (`POST /api/v1/agent-sessions/close`). One POST with a 1 s timeout, fire-and-forget |
| `3ngram-hook precheck` | PreToolUse | Surface related memories before Write/Edit/apply_patch (`POST /api/v1/search`) |
| `3ngram-hook sync [--push\|--pull\|--both]` | (none) | **Deferred** — a no-op (prints "not yet supported" and exits 0); the sync routes do not exist yet. SessionEnd now runs `close` instead |
| `3ngram-hook verify` | (manual) | Print resolved API base + key status, probe `GET /api/v1/briefing` |
| `3ngram-hook version` | (manual) | Print the binary version (also `--version`) |

Every subcommand accepts `--agent <name>` — the harness half of the session
natural key `(agent, session_id)`. Claude Code is detected from its own
environment; name the harness explicitly anywhere else (see
[Session lifecycle](#session-lifecycle)).

## Session lifecycle

`briefing`, `heartbeat` and `close` drive the `agent_sessions` bookkeeping row
described in [`docs/concepts/session-continuity.mdx`](../../docs/concepts/session-continuity.mdx).
Nothing here writes a memory.

- **SessionStart** (`briefing`) resolves the hook's `source`: `startup` opens the
  row and stamps the `{id, topic, status}` commitments that survived the local
  `BRIEFING_MAX_TOKENS` truncation; `resume` reuses the row and never restamps;
  `compact` is neither an open nor a restamp — it heartbeats the row to recover
  the `sessionRunId` that compaction discarded with the context; `clear` asks the
  server which of the two it is (an unknown natural key means the harness minted
  a new conversation id, so it opens as `startup`).
- The `sessionRunId` and an instruction to pass it on `remember` / `revise` /
  `resolve` are appended to the injected briefing. Propagation is
  **model-mediated and best-effort** — a write that omits it falls back to the
  server's single-open-session default.
- **Stop** (`heartbeat`) keeps the lease live across completed turns. It carries
  no triage logic and emits no `decision` envelope.
- **SessionEnd** (`close`) is best-effort by construction: a killed terminal or a
  failed POST just leaves the row for the lease-expiry sweep.

Sub-agents (`THREENGRAM_HOOK_ROLE=subagent`) and secondary git worktrees are
skipped by all three, exactly as the briefing auto-pull already was. Register
main-agent `Stop` only — never `SubagentStop`.

## Build (from source)

```bash
cd cmd/3ngram-hook
CGO_ENABLED=0 go build -ldflags="-s -w" -o 3ngram-hook .
```

Cross-compile:

```bash
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o 3ngram-hook-darwin-arm64 .
```

## Install (released binaries)

Prebuilt binaries are published to
[GitHub Releases](https://github.com/B3dmar/3ngram/releases) for Linux and
macOS (`amd64` + `arm64`) on every `3ngram-hook-v*` tag (see
[`.github/workflows/release-3ngram-hook.yml`](../../.github/workflows/release-3ngram-hook.yml)).
Verify the `sha256` checksum in `checksums.txt`, unpack onto your `PATH`, then
continue with [Bootstrap](#bootstrap).

```bash
3ngram-hook --version
# 3ngram-hook 3ngram-hook-v1.0.0
```

## Bootstrap

The briefing and precheck hooks need an API key to read from the REST API.
Without one they exit silently — hooks must never block your tool calls — and
print a one-shot banner to stderr at most once per hour.

1. **Create an API key** at https://app.3ngram.ai/settings/api-keys. The full
   key is shown once (format: `3ng_<prefix>_<secret>`). Copy it immediately.
2. **Tell the hook about it**, either:
   - Export `THREENGRAM_API_KEY=3ng_…` in your shell profile or the `env` block
     of `~/.claude/settings.json`, or
   - Write the key to `~/.config/3ngram/api-key` (one line, no quotes).
3. **Verify** the pipeline:
   ```bash
   3ngram-hook verify
   # 3ngram-hook verify
   #   API base: https://api.3ngram.ai
   #   API key:  3ng_abcd… (N chars)
   #   briefing: 200
   # OK — briefing pipeline is configured.
   ```
   Exit codes: `0` configured + reachable, `1` no key, `2` unreachable / key
   rejected (401) / service unavailable (503).

The X-API-Key chain (`apps/server/src/middleware/api-key.ts`) returns `200` for
a valid key, a uniform `401` for missing/unknown/revoked keys, and `503` if the
resolver/DB is unavailable.

## Claude Code hooks

Claude Code reads its hooks from `~/.claude/settings.json` (or a project
`.claude/settings.json`) under the top-level `hooks` key. `SessionStart` matches
on the activation source; `Stop` and `SessionEnd` take no matcher, so the
`matcher` key is omitted for them.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          { "type": "command", "command": "3ngram-hook briefing", "timeout": 10 }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "3ngram-hook precheck", "timeout": 2 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "3ngram-hook heartbeat", "timeout": 5 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "3ngram-hook close", "timeout": 5 }
        ]
      }
    ]
  }
}
```

`timeout` is per hook, in seconds. `close` self-limits its POST to 1 s, so it
fits the SessionEnd budget whether or not the per-hook `timeout` raises it.
Register `Stop`, **not** `SubagentStop`.

## Codex hooks

Register the binary in `~/.codex/hooks.json` after installing it on your
`PATH`. Codex requires the JSON `additionalContext` output that this binary
emits for `PreToolUse`; plain stdout is intentionally ignored for that event.

`--agent codex` rides the command itself: the natural key needs the harness
name, and a hook registration is the one place that knows for certain which
harness will run the binary.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "3ngram-hook briefing --agent codex",
            "timeout": 10,
            "statusMessage": "Loading 3ngram briefing"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "apply_patch|Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "3ngram-hook precheck",
            "timeout": 2,
            "statusMessage": "Checking 3ngram memory"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "3ngram-hook heartbeat --agent codex",
            "timeout": 5,
            "statusMessage": "Refreshing 3ngram session"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "3ngram-hook close --agent codex",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

Codex's SessionEnd allows up to 3 s (1 s by default); the `close` POST gives up
at 1 s regardless. Restart Codex, then use `/hooks` to review and trust the hook
definition.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `THREENGRAM_API_BASE` | `https://api.3ngram.ai` | REST API base URL (preferred) |
| `THREENGRAM_API_URL` | (fallback for `THREENGRAM_API_BASE`) | Legacy alias |
| `THREENGRAM_API_KEY` | (none) | API key for `X-API-Key` auth |
| `THREENGRAM_SCOPE` | `personal` | Scope for briefing/search (`personal`/`work`/…) |
| `THREENGRAM_BRIEFING_KIND` | (auto) | Briefing selector: `all`, `scope`, or `project` |
| `THREENGRAM_AGENT` | (auto) | Harness name for the session natural key (kebab-case). `--agent` on the subcommand wins; Claude Code is auto-detected; anything else falls back to `unknown-agent` |
| `THREENGRAM_HOOK_ROLE` | (none) | Set to `subagent` to suppress the briefing auto-pull and every session-lifecycle call |
| `THREENGRAM_HOOK_DEBUG` | `0` | Set to `1` to dump payloads to `/tmp/3ngram-hook-debug/` |
| `THREENGRAM_PRECHECK_DISABLE` | `0` | Set to `1` to disable the PreToolUse surfacing |
| `THREENGRAM_PRECHECK_LIMIT` | `3` | Max memories surfaced by precheck |
| `BRIEFING_MAX_TOKENS` | `2000` | Token budget for briefing output |

API key lookup order: `THREENGRAM_API_KEY` env →
`$XDG_CONFIG_HOME/3ngram/api-key` → `~/.config/3ngram/api-key`.

When the hook runs from a secondary git worktree it suppresses the briefing
auto-pull — and every session-lifecycle call — so an orchestrator's sub-agents
inherit context without re-pulling and never open, lease or close a row of their
own (also via `THREENGRAM_HOOK_ROLE=subagent` for Task-dispatched sub-agents that
inherit the main worktree cwd).

## Local development

```bash
export THREENGRAM_API_BASE=http://localhost:3000
export THREENGRAM_API_KEY=3ng_localdevkey
3ngram-hook verify
```

## Releasing

Push a `3ngram-hook-v*` tag to trigger
[`.github/workflows/release-3ngram-hook.yml`](../../.github/workflows/release-3ngram-hook.yml):
it cross-compiles linux/darwin × amd64/arm64, generates `checksums.txt`
(sha256), and uploads to a GitHub Release. The tag is embedded via
`-ldflags="-X main.version=..."`.

```bash
git tag 3ngram-hook-v1.0.0
git push origin 3ngram-hook-v1.0.0
```

`workflow_dispatch` runs the build + checksum steps without publishing.
