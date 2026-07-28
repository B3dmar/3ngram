# 3ngram-hook

Static, zero-dependency Go binary that integrates Claude Code and Codex with the 3ngram
REST API (`/api/v1`). It replaces forked bash hook scripts — fetching a session
briefing and surfacing relevant memories before file edits — all fire-and-forget
so a hook never blocks your workflow.

Built for the 3ngram backend:
the briefing reads the single `GET /api/v1/briefing` orientation endpoint and the
precheck surfaces memories via `POST /api/v1/search`. The binary is a read-side
context feed; high-value write capture (LLM-summarized decisions/commitments) is
handled by the `/debrief` skill, not a mechanical hook.

## Subcommands

| Command | Hook Event | Description |
|---------|-----------|-------------|
| `3ngram-hook briefing` | SessionStart | Fetch `GET /api/v1/briefing`, render markdown briefing |
| `3ngram-hook precheck` | PreToolUse | Surface related memories before Write/Edit/apply_patch (`POST /api/v1/search`) |
| `3ngram-hook sync [--push\|--pull\|--both]` | SessionEnd | **Deferred** — currently a no-op (prints "not yet supported" and exits 0); the sync routes do not exist yet |
| `3ngram-hook verify` | (manual) | Print resolved API base + key status, probe `GET /api/v1/briefing` |
| `3ngram-hook version` | (manual) | Print the binary version (also `--version`) |

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

## Codex hooks

Register the binary in `~/.codex/hooks.json` after installing it on your
`PATH`. Codex requires the JSON `additionalContext` output that this binary
emits for `PreToolUse`; plain stdout is intentionally ignored for that event.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "3ngram-hook briefing",
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
    ]
  }
}
```

Restart Codex, then use `/hooks` to review and trust the hook definition.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `THREENGRAM_API_BASE` | `https://api.3ngram.ai` | REST API base URL (preferred) |
| `THREENGRAM_API_URL` | (fallback for `THREENGRAM_API_BASE`) | Legacy alias |
| `THREENGRAM_API_KEY` | (none) | API key for `X-API-Key` auth |
| `THREENGRAM_SCOPE` | `personal` | Scope for briefing/search (`personal`/`work`/…) |
| `THREENGRAM_BRIEFING_KIND` | (auto) | Briefing selector: `all`, `scope`, or `project` |
| `THREENGRAM_HOOK_ROLE` | (none) | Set to `subagent` to suppress the briefing auto-pull |
| `THREENGRAM_HOOK_DEBUG` | `0` | Set to `1` to dump payloads to `/tmp/3ngram-hook-debug/` |
| `THREENGRAM_PRECHECK_DISABLE` | `0` | Set to `1` to disable the PreToolUse surfacing |
| `THREENGRAM_PRECHECK_LIMIT` | `3` | Max memories surfaced by precheck |
| `BRIEFING_MAX_TOKENS` | `2000` | Token budget for briefing output |

API key lookup order: `THREENGRAM_API_KEY` env →
`$XDG_CONFIG_HOME/3ngram/api-key` → `~/.config/3ngram/api-key`.

When the hook runs from a secondary git worktree it suppresses the briefing
auto-pull so an orchestrator's sub-agents inherit context without re-pulling
(also via `THREENGRAM_HOOK_ROLE=subagent` for Task-dispatched sub-agents that
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
