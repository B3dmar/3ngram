# 3ngram for Claude Code

A read-only commitment panel inside Claude Code, plus the 3ngram session hooks. It lists the current project's open, waiting and overdue commitments from your 3ngram memory, says where each came from, and shows related evidence that one may be done. It never changes a memory and never adds a backlog. Its Session tab shows the memories the agent was observed reading and changing through 3ngram's MCP tools during the session.

Needs Claude Code 2.1.287 or later in the terminal (2.1.286 or later in the Desktop app's Code tab), where mods are on by default; no feature flag is needed, and the early-access `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is ignored from 2.1.287. Tested with 2.1.291 and 2.1.292. The plugin API (mods) is early access and can change between releases.

## Install

The panel reads through the `3ngram-hook` binary, so build it first (see [`cmd/3ngram-hook`](../../cmd/3ngram-hook/README.md)); it uses the same API key and the same project as the session hooks.

```text
/plugin install 3ngram --marketplace B3dmar/3ngram
```

Answer `y` to add the marketplace, then pick a scope. For one session from a checkout instead:

```bash
claude --plugin-dir plugins/3ngram
```

Run `/commitments` to open the panel. It starts on **Commitments**; select **Session** (`s`) to see observed memory activity, or **Commitments** (`t`) to return. The active tab survives a plugin reload; a new conversation starts on Commitments. Change the options with `/plugin configure 3ngram` or in `/config`:

| Option | Default | What it does |
|---|---|---|
| `scope` | empty | Read within this 3ngram scope. Empty reads the project in any scope |
| `include_unscoped` | off | Also show the scope's commitments written without a project. Needs a scope |
| `refresh_minutes` | 5 | Background refresh interval, 1 to 60 |
| `github_evidence` | on | Look up the GitHub issues and pull requests commitments mention, read-only |
| `auto_open` | off | Open the panel at session start, once a session: a reload (an option changed in `/config`, say) does not open it again. Claude Code draws a pane opened unasked only from 144 terminal columns (110 once you have opened it yourself), and holds it until then |

## The bundled hooks

The plugin also registers the four 3ngram session hooks (SessionStart briefing, PreToolUse precheck, Stop heartbeat, SessionEnd close) through `scripts/run-hook`. If you already registered them in `settings.json`, the plugin's copies stand down for each event instance the guard can confirm your settings cover. This is best effort, not exact: where it cannot tell, the plugin copy runs too, and a few setups it cannot see are listed in [the hook README](../../cmd/3ngram-hook/README.md#claude-code-plugin). Registering the hooks in one place, settings or the plugin, avoids both. A machine without `3ngram-hook`, or with a build older than the guard, gets no hooks from the plugin and no error. The plugin supports macOS and Linux; Windows is not supported in this version (there is no Windows build of `3ngram-hook`).

## What it shows, and what it does not

- **The context, at both ends.** The header names the project and the scope ("any scope" without one), beside the time of the last read (on a line of its own where the pane is too narrow). The footer names the backend, the account, where the project name came from, and whether unscoped records are included.
- **Compact rows.** Rows sit under `! OVERDUE`, `◦ OPEN` and `◒ WAITING`, each section told apart by its mark and its word, never by color alone; the marks are one cell wide in every terminal (`○` and `◐` are of ambiguous width, and two cells where a terminal draws those wide). Each row is its title, cut at the pane edge, and a line of labels, its deadline first: "due today 18:00", "due in 5 days · 10 Nov 18:00", "3 days overdue · due 2 Nov 18:00", counted in calendar days. A deadline is the instant past which briefing reads the row as overdue, so its time of day always shows, and at that very instant it is still due. GitHub references show as the topic wrote them (`#407 open`).
- **Rows only with their selection, across a reload.** Changing the scope, the unscoped opt-in or GitHub lookups reloads the plugin, and Claude Code keeps the panel's state across the reload. Nothing it held draws until the new selection has been compared with it, and rows or a detail read under the old selection are cleared, never shown. Rows held under an unchanged selection wait for the context check below, since the key or backend can have changed in between; a read still running from before the reload cannot end that wait early.
- **Rows only with their context.** Every read carries a fingerprint of the backend, the key and the selection, and rows are kept only next to the read that produced them. Before each refresh the panel checks the context with `3ngram-hook commitments context`, which makes no request, so rows read under another key or backend are cleared before the new read starts. A list or detail read whose content would be shown is checked once more after it returns, so a key changed while it ran never shows that read. An open detail also closes when a refresh shows its row changed: its filing, its commitment status, or the state of a GitHub reference it names. A detail whose answer disagrees with the row listed when it arrives (a filing or status changed while it was read) shows that instead of the answer. After a failure, rows stay (marked stale) only when the failed attempt is verified to be the same context; anything else clears the list and the detail view. An open detail hides whenever the rows do. It comes back with them, marked stale, only when the context check confirms the same context, and a detail still loading when a read fails is closed. A Cancel, or a reload during a read, closes the open detail even when its answer is in; the rows still come back stale once the check confirms the context.
- **Nothing is left running.** Cancel, `/clear`, `/resume`, `/branch` and a reload stop the list and detail reads in flight, including startup still settling its context. The fresh read after `/clear`, `/resume` or `/branch` starts once the session state has been reset. A refresh that clears the open detail stops its read too; every read has a 12 s ceiling. A refresh asked for during a read runs once it ends, and a stop drops it, as it does the list read a detail asks for when it finds its context changed. Back keeps that follow-up once the detail has finished its context check.
- **No background reads where nothing draws.** A `claude -p` run or an Agent SDK session reads nothing in the background, so it makes no REST reads and runs no `gh`. The background reads start if a client attaches to that session later, and stop again when the last one detaches, a startup already under way included.
- **Unscoped means verified.** A row is labelled unscoped only after its memory is read back with no project; otherwise it is "filing unknown".
- **Owners and sources.** Native writes never record an owner, and the read API does not expose the session a memory was written in, so the panel guesses neither: a row shows `owner <name>` only where one is recorded, the footer says "owners not recorded" when a row shown has none, and the detail says "source session: not exposed".
- **Stale rows are marked, and say how old they are.** When a refresh fails under the same context, the list keeps its rows marked stale with the reason, the time it first failed and the time the rows were read. An open detail shows the same line. While a refresh runs, the rows it keeps showing say when they were read. Times are in the host's time zone, as the module runtime reports it (`Intl`), with its short name beside them ("Updated 17:40 CET"); a zone the runtime cannot use is read as UTC, never guessed. A time from an earlier day carries its date, and an open pane is drawn again at the next local midnight, so none passes for today's and every deadline counts from the right day.
- **Errors say what the binary said.** Under an error, its hint from `3ngram-hook` (a fixed phrase of the binary's, such as "response body too large") is shown dim, unless the error's own text already says it.
- **Evidence is for review.** A newer memory that updates or supersedes a commitment, a pending proposal touching it, or a merged pull request it mentions is shown as related evidence. "No evidence found in the inspected window" says how far the search looked, and when no source could be read at all the panel says that nothing was searched.
- **Partial results are labelled.** A truncated list, an unavailable account, an unfinished check or a GitHub lookup that stopped is named in a note under the list.

## What it records about the session

- **The Session tab.** Each MCP server has its own Read / Wrote / Resolved counts, five most recent retained write events, five most-read retained memories, and latest observed MCP briefing summary. Extra rows, evicted history and lower-bound counts are labelled. These are observed tool results, not proof that the agent used a memory in its reasoning. The tab spans observed MCP servers; it is not filtered to the commitment panel's selected account or project. No cross-panel activity markers are shown because server names do not establish that account mapping.
- **Which calls.** The agent's calls to 3ngram's MCP tools, in the main conversation and in subagents. A tool counts when its name, `mcp__<server>__<tool>`, has a server whose name holds `3ngram` as a word of its own (`3ngram`, `3ngram-personal`, `claude_ai_3ngram`). The name is all the plugin is given about a call's server, so a server named that way that is not 3ngram is counted too.
- **What it keeps.** For each call: the server, the tool, whether it read or wrote, how it ended (answered, an error, refused, or an answer it could not read) and the subagent it ran in. For each memory a result listed or a call changed: its id, type, topic (the first 200 characters), scope, project, status, when it was first and last seen, how often and by which tools it was read, and what the agent did to it (remembered, revised, written as a revision, moved, archived, reaffirmed, resolved, or a proposal on it applied or rejected). Never a memory's content, a fact's value or a proposal's rationale.
- **Separate counts per server.** Two servers can be two accounts: the same memory under two servers is two entries, and no count adds them up. Read counts distinct returned memory IDs; wrote counts distinct IDs with successful write outcomes, excluding explicit no-ops and rejected proposals. Resolved counts IDs returned as resolved or archived by `resolve`; reopening does not count as resolving. Repeated reads affect ranking, not the distinct count.
- **Write history and briefings.** Write events keep their own timestamps and metadata, so a later read cannot make an earlier write appear recent. Each server retains the latest observed MCP briefing's selector, section totals, returned counts and truncation flags. Automatic startup briefings use the Go hook and REST, so this observer does not see them.
- **Bounded.** The last 200 calls, last 200 write events and at most 500 memories and 16 servers. Past that the memory read longest ago goes first, before any memory the agent changed. Drops are counted per server so consumers can label incomplete history and counts as lower bounds.
- **For the session only.** It lives in the plugin's session state, never in the store: a plugin reload and a compaction keep it, and `/clear`, `/resume` and `/branch` start it over. Session boundaries cancel queued recordings, drain pending state writes and discard results from tools started in the previous conversation.

## Read-only, by construction

- The module runs only `3ngram-hook commitments context|list|show`, through an allowlist checked before every spawn. It never calls the network, an MCP server, the file system or the store, and it reads no environment variable: `claude plugin validate plugins/3ngram` lists every call it makes.
- It watches the agent's calls to 3ngram's MCP tools (a `tool.call` hook) and their results, only to record what the agent used. It never makes a call of its own and never changes or refuses one: the call runs as the agent made it, its result goes back as the very object it came as, and the recording runs after that, from a timer. A failure while recording loses that one entry, never the call.
- The binary sends only GET requests (enforced by a parse-level allowlist in its tests) and runs `gh` only as `gh api --method GET`.
- The `/commitments` reply and the status line carry no record content: the model and the status bar see counts and a fixed line, never a topic. Commitment counts show only while the rows do; while their context is checked the status says "3ngram: checking". One observed MCP server adds distinct read/wrote/resolved counts; multiple servers add only a server count. Session topics appear only in the pane, never in a model reply or status line.

## Development

```bash
pnpm --filter @3ngram/claude-code-plugin test    # pure logic, node --test (runs in CI)
pnpm --filter @3ngram/claude-code-plugin check   # tsc over the pure logic and specs
claude plugin validate plugins/3ngram            # manifest, module, calls
claude plugin test plugins/3ngram                # engine-kit tests (local only)
```

The engine-kit tests need the Claude Code CLI, which is not in the lockfile, so CI runs the specs under `spec/` and the engine tests are run locally before each change. The specs parse the binary's golden envelopes in `cmd/3ngram-hook/testdata/commitments/`, so a contract change fails on both sides. The session record's specs check every 3ngram tool result they read against the output schemas in `@3ngram/schema`, and its tool list against the MCP surface snapshot in `eval/fixtures/transport-surfaces.json`, so a new tool or a moved field fails them too. `pnpm test` builds the schema first; running the plugin's specs alone needs `pnpm --filter @3ngram/schema build` once.

An install Claude Code copies into its plugin cache, such as one from the GitHub marketplace above, is pinned to the `version` in `.claude-plugin/plugin.json`: `claude plugin update`, `/plugin marketplace update` and auto-update replace the cached copy only when that string changes ([Versions and updates](https://code.claude.com/docs/en/plugins/loading#versions-and-updates)). A plugin loaded in place from a marketplace added from a local path reads its current files at every session start, whatever the version says. So the first PR that changes the plugin after each promotion to `main` bumps the version, in `plugin.json` and `package.json` together; later PRs before the next promotion leave it. Keep `version` out of `.claude-plugin/marketplace.json`, where `plugin.json` would override it.
