# 3ngram-hook

Static, zero-dependency Go binary that integrates Claude Code and Codex with the 3ngram
REST API (`/api/v1`). It replaces forked bash hook scripts — fetching a session
briefing and surfacing relevant memories before file edits — all fire-and-forget
so a hook never blocks your workflow.

The one exception is opt-in and off by default: the
[Stop debrief nudge](#stop-nudge-default-off) continues a turn when the server
says the session is worth debriefing. It runs only with
`THREENGRAM_STOP_NUDGE=1`; everything else, including the rest of the Stop hook,
stays fire-and-forget.

Built for the 3ngram backend:
the briefing reads the single `GET /api/v1/briefing` orientation endpoint and the
precheck surfaces memories via `POST /api/v1/search`. The binary is a read-side
context feed plus session BOOKKEEPING (`agent_sessions` open / heartbeat /
triage / close — no memory rows, ever); high-value write capture (LLM-summarized
decisions/commitments) is handled by the `/debrief` skill, not a mechanical hook.
The nudge does not change that: it asks the *model* to call `remember` /
`resolve`, and writes nothing itself.

## Subcommands

| Command | Hook Event | Description |
|---------|-----------|-------------|
| `3ngram-hook briefing` | SessionStart | Fetch `GET /api/v1/briefing?mode=full`, render + locally truncate the markdown briefing, open/refresh the session row, and inject the `sessionRunId` |
| `3ngram-hook stop` | Stop | Refresh the session lease and snapshot a bounded `last_assistant_message` (`POST /api/v1/agent-sessions/heartbeat`). With `THREENGRAM_STOP_NUDGE=1` it additionally runs the [debrief nudge](#stop-nudge-default-off); without it, never blocks, never prints, always exits 0 |
| `3ngram-hook heartbeat` | Stop | **Alias for `stop`** — identical behavior. Kept so existing registrations keep working; the nudge is gated by the flag, not by the subcommand name. **Register one or the other, never both** (see below) |
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

`briefing`, `stop` and `close` drive the `agent_sessions` bookkeeping row
described in [`docs/concepts/session-continuity.mdx`](../../docs/concepts/session-continuity.mdx).
Nothing here writes a memory.

- **SessionStart** (`briefing`) resolves the hook's `source`: `startup` opens the
  row and stamps the `{id, topic, status}` commitments that survived the local
  `BRIEFING_MAX_TOKENS` truncation; `resume` reuses the row and never restamps;
  `compact` is neither an open nor a restamp — it heartbeats the row to recover
  the `sessionRunId` that compaction discarded with the context; `clear` asks the
  server which of the two it is — a `404` means the harness minted a new
  conversation id, so it opens as `startup`, while a `200` is already the answer
  (the probe returned the run id and refreshed the lease, so no second call is
  made). Any other probe result is not an existence answer: the briefing is still
  delivered, the lifecycle is skipped, and one line goes to stderr.
- A failed or unparseable briefing does **not** skip the open. The read and the
  bookkeeping write are independent calls, and Stop never creates a missing row —
  so the session would otherwise run unattributed because one read went wrong.
  `briefedMemories` is omitted in that case, since no briefing was delivered.
- The `sessionRunId` and an instruction to pass it on `remember` / `revise` /
  `resolve` are appended to the injected briefing. Propagation is
  **model-mediated and best-effort** — a write that omits it falls back to the
  server's single-open-session default.
- **Stop** (`stop`) keeps the lease live across completed turns. That half is
  unconditional and always silent. The [debrief nudge](#stop-nudge-default-off)
  is additive and **off unless `THREENGRAM_STOP_NUDGE=1`**.
- **SessionEnd** (`close`) is best-effort by construction: a killed terminal or a
  failed POST just leaves the row for the lease-expiry sweep.

Sub-agents (`THREENGRAM_HOOK_ROLE=subagent`) and secondary git worktrees are
skipped by all three, exactly as the briefing auto-pull already was. Register
main-agent `Stop` only — never `SubagentStop`.

## Stop nudge (default-off)

`3ngram-hook stop` can also ask the server whether this turn is worth a debrief,
and — only if the server says yes — continue the turn with the debrief prompt.
It implements layer 4 of
[`session-continuity.mdx`](../../docs/concepts/session-continuity.mdx) and is
**off unless you set `THREENGRAM_STOP_NUDGE=1`**. With the flag unset the Stop
hook is byte-for-byte the heartbeat it has always been and never calls a triage
route at all.

**3ngram owns the words, the hook owns the trigger.** Each Stop:

1. `POST /api/v1/agent-sessions/triage/begin` with the natural key. The **server**
   evaluates the entry rule and the debounce and answers `armed` — so the rule is
   identical on every harness. Most Stops decline, and a decline is silent.
2. If armed, `GET /api/v1/prompts/debrief` renders the prompt for this run, with
   the run's briefed commitments inlined as an id → topic/status mapping.
3. The prompt is emitted **verbatim** as a blocking Stop envelope
   (`{"decision":"block","reason":…}`). The hook never edits the text.
4. On the next Stop, `begin` reports the attempt is still `pending` and hands
   back its id, and the hook calls `POST …/triage/complete` to absorb whatever
   the continuation wrote. No local state file is involved — the attempt id
   round-trips through the server, because Stop is a fresh process every time.

No turn-count hint is sent: neither harness puts a turn count in the Stop
payload, and the transcript is not a stable interface. The server's elapsed-time
and untriaged-event disjuncts cover the debounce without it.

**The cap.** Injection is capped at **one per attempt**, and the count lives in
the server's `pending` state rather than in a counter the hook cannot keep. That
matters because the loop guard cannot be trusted: Codex has no continuation cap
at all, Claude's eight-block override is configurable
(`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) and can fail to propagate
(anthropics/claude-code#54360), and Gemini CLI 0.30.0 hardcodes it false
(gemini-cli#20426). Because `begin` arms exactly once per attempt and re-arming
requires a provenance event outside the stamped watermark, an ungated loop is
not possible: a continuation that writes nothing cannot re-arm (nothing new
exists) and one that writes something cannot re-arm on its own writes
(`complete` absorbed them). The honest residual bound is **one nudge per turn
that produced new provenance**, not "never twice in a session". Full analysis in
the `maxInjectionsPerAttempt` comment in `nudge.go`.

**Failure is always silent.** A dead server, a 404, a rejected facet or an empty
prompt all exit 0 with nothing on stdout. A blank `reason` is a hook *failure* on
Codex, so the hook declines to inject rather than emit one — and hands the armed
attempt back so the closer still picks the session up.

<!-- markdownlint-disable-next-line -->
> **Register `stop` OR `heartbeat` — never both.** They are the same command,
> and a harness runs every matching hook for an event **concurrently**. Two
> processes for one Stop means one of them can arm an attempt while the other
> sees it as `pending` and finalizes it before the first has emitted its
> envelope; that continuation's writes then land outside the stamped watermark
> and a later Stop can nudge a second time for the same work. One registration
> makes this unreachable. Tracked for a server-side age guard in
> [issue #188](https://github.com/B3dmar/3ngram/issues/188).

**Facets come from the session row, not from this process.** The hook sends only
the natural key to `GET /api/v1/prompts/debrief`; the server fills `scope` and
`project` from `agent_sessions`. That matters when a tenant retrieval policy
narrows a `kind=all` briefing to a default scope — the row records the scope the
agent was actually briefed under, and `THREENGRAM_SCOPE` may not even be set.

### Validation checkpoint — do this before relying on it

Claude Code's own hooks reference and Anthropic's shipped `ralph-wiggum` Stop
plugin currently document **different** blocking shapes (the plugin uses
top-level `decision`/`reason`, which is what this hook emits; the reference now
documents `hookSpecificOutput.continueConversation`). We follow the working
artifact, but that is an empirical bet on your installed build:

> **Enable the flag once and verify a Stop actually continues the turn on your
> Claude Code version.** If the turn stops instead, the envelope needs the
> `continueConversation` form — a two-line change in `continuationEnvelope`
> (`nudge.go`), which documents both shapes and the swap.

Beyond that, this is the "one project, one harness, default-off" rollout the
concept page requires: turn it on for **one** project first and measure the
extra-turn cost and ignore-rate before widening. The go/no-go bar is the
validation bar on that page, and it has not been measured yet.

## Build (from source)

```bash
cd cmd/3ngram-hook
CGO_ENABLED=0 go build -ldflags="-s -w" -o 3ngram-hook .
```

`contract_gen.go` is generated and committed, so a source build needs no Node
toolchain. It carries the two bounds the hook must honour before it builds a
request body (`MAX_SESSION_EXCERPT_LENGTH`, `MAX_BRIEFED_MEMORIES`), mirrored
from `packages/schema` by `scripts/gen-hook-contract.mjs`. Regenerate with
`pnpm run docs:generate` from the repo root; CI's `docs-reference` lane diffs it
byte for byte, so a schema change that is not regenerated goes red. Nothing else
from the Zod boundary is mirrored — the server's parse is the single validator
for shapes.

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
          { "type": "command", "command": "3ngram-hook stop", "timeout": 5 }
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
Register `Stop`, **not** `SubagentStop`. `3ngram-hook heartbeat` remains a valid
alias, so an existing registration needs no edit.

### Enabling the Stop nudge (Claude Code)

Claude Code is the **one registered harness** for the nudge's validation phase.
The subcommand does not change — the flag does. Raise the `Stop` timeout,
because the armed path makes three short calls (`begin`, the prompt render,
`complete`) on top of the 2 s heartbeat:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "3ngram-hook stop", "timeout": 10 }
        ]
      }
    ]
  },
  "env": {
    "THREENGRAM_STOP_NUDGE": "1"
  }
}
```

Read [Stop nudge (default-off)](#stop-nudge-default-off) — including the
validation checkpoint — before turning this on. Leave the flag unset and the
registration above behaves exactly as it does today.

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
            "command": "3ngram-hook stop --agent codex",
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

### Stop nudge on Codex — deferred, after the validation bar

The Codex continuation envelope **ships** in this binary: `deriveAgent` resolves
`--agent codex`, and `continuationEnvelope` emits the portable
`{"decision":"block","reason":…}` without Claude's universal extras (Codex has no
`hookSpecificOutput` on Stop). The blank-`reason` guard exists specifically for
Codex, where an empty reason is a hook *failure* rather than a no-op.

**Registration here is deliberately not documented yet.** The concept page's
rollout is "one project, one harness, default-off", and Claude Code is that
harness for the validation phase — so there is no `THREENGRAM_STOP_NUDGE`
recipe on this page. The reason is specific rather than procedural: Codex has
**no built-in continuation cap** (openai/codex#37937), so an ungated triage there
is an infinite turn loop rather than an annoyance, and openai/codex#20783 is a
known caveat where a blocking continuation can fail with an invalid message id.
The hook's own cap (one injection per attempt, held server-side) is what would
make it safe, and measuring that is exactly what the validation bar is for.

Do **not** enable the flag on a Codex registration until the bar in
[`session-continuity.mdx`](../../docs/concepts/session-continuity.mdx) holds.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `THREENGRAM_API_BASE` | `https://api.3ngram.ai` | REST API base URL (preferred) |
| `THREENGRAM_API_URL` | (fallback for `THREENGRAM_API_BASE`) | Legacy alias |
| `THREENGRAM_API_KEY` | (none) | API key for `X-API-Key` auth |
| `THREENGRAM_SCOPE` | `personal` | Scope for briefing/search (`personal`/`work`/…) |
| `THREENGRAM_BRIEFING_KIND` | (auto) | Briefing selector: `all`, `scope`, or `project` |
| `THREENGRAM_AGENT` | (auto) | Harness name for the session natural key (kebab-case). `--agent` on the subcommand wins; Claude Code is auto-detected; anything else falls back to `unknown-agent` with a one-time stderr note |
| `THREENGRAM_HOOK_ROLE` | (none) | Set to `subagent` to suppress the briefing auto-pull and every session-lifecycle call |
| `THREENGRAM_STOP_NUDGE` | `0` | Set to **exactly** `1` to enable the [Stop debrief nudge](#stop-nudge-default-off). Anything else (including `true`) leaves Stop heartbeat-only. Claude Code is the only registered harness during the validation phase |
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
