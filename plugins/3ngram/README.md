# 3ngram for Claude Code

A read-only commitment panel inside Claude Code. It lists the current project's open, waiting and overdue commitments from your 3ngram memory, says where each came from, and shows related evidence that one may be done. It never changes a record and never adds a backlog.

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

Run `/commitments` to open the panel. Change the options with `/plugin configure 3ngram` or in `/config`:

| Option | Default | What it does |
|---|---|---|
| `scope` | empty | Read within this 3ngram scope. Empty reads the project in any scope |
| `include_unscoped` | off | Also show the scope's commitments written without a project. Needs a scope |
| `refresh_minutes` | 5 | Background refresh interval, at least 1 |
| `github_evidence` | on | Look up the GitHub issues and pull requests commitments mention, read-only |
| `auto_open` | off | Open the panel at session start, on a terminal wide enough to dock it |

## What it shows, and what it does not

- **The context first.** The header names the backend, the account, the project and where its name came from, the scope, and whether unscoped records are included.
- **Rows only with their context.** Every read carries a fingerprint of the backend, the key and the selection, and rows are kept only next to the read that produced them. Before each refresh the panel checks the context with `3ngram-hook commitments context`, which makes no request, so rows read under another key or backend are cleared before the new read starts. A list or detail read whose content would be shown is checked once more after it returns, so a key changed while it ran never shows that read. An open detail also closes when a refresh shows its row changed: its filing, its commitment status, or the state of a GitHub reference it names. After a failure, rows stay (marked stale) only when the failed attempt is verified to be the same context; anything else clears the list and the detail view. An open detail hides whenever the rows do, and does not come back by itself.
- **Nothing is left running.** Cancel, `/clear`, `/resume`, `/branch` and a reload stop the list and detail reads in flight (the fresh read after `/clear`, `/resume` or `/branch` starts once the session state has been reset), and so does a refresh that clears the open detail; every read has a 12 s ceiling; a refresh asked for during a read runs once it ends. One known gap: a Cancel, `/clear`, reload or detach that lands while a read is recording a context change can let one more read run ([#269](https://github.com/B3dmar/3ngram/issues/269)).
- **No background reads where nothing draws.** A `claude -p` run or an Agent SDK session reads nothing in the background, so it makes no REST reads and runs no `gh`. The background reads start if a client attaches to that session later, and stop again when the last one detaches; a startup read whose timer has already fired can still run once after that ([#269](https://github.com/B3dmar/3ngram/issues/269)).
- **Unscoped means verified.** A row is labelled unscoped only after its memory is read back with no project; otherwise it is "filing unknown".
- **Owners and sources.** Native writes never record an owner, and the read API does not expose the session a memory was written in, so the panel says "owner unclear (not recorded)" and "source session: not exposed" instead of guessing.
- **Stale rows are marked, an open detail is not yet.** When a refresh fails under the same context, the list keeps its rows marked stale with the reason. While a detail is open it keeps showing its last answer, and the stale mark and reason appear only after Back ([#269](https://github.com/B3dmar/3ngram/issues/269)).
- **Evidence is for review.** A newer memory that updates or supersedes a commitment, a pending proposal touching it, or a merged pull request it mentions is shown as related evidence. "No evidence found in the inspected window" says how far the search looked, and when no source could be read at all the panel says that nothing was searched.
- **Partial results are labelled.** A truncated list, an unavailable account, an unfinished check or a GitHub lookup that stopped is named in a note under the list.

## Read-only, by construction

- The module runs only `3ngram-hook commitments context|list|show`, through an allowlist checked before every spawn. It never calls the network, an MCP server, the file system or the store, and it reads no environment variable: `claude plugin validate plugins/3ngram` lists every call it makes.
- The binary sends only GET requests (enforced by a parse-level allowlist in its tests) and runs `gh` only as `gh api --method GET`.
- The `/commitments` reply and the status line carry no record content: the model and the status bar see counts and a fixed line, never a topic.

## Development

```bash
pnpm --filter @3ngram/claude-code-plugin test    # pure logic, node --test (runs in CI)
pnpm --filter @3ngram/claude-code-plugin check   # tsc over the pure logic and specs
claude plugin validate plugins/3ngram            # manifest, module, calls
claude plugin test plugins/3ngram                # engine-kit tests (local only)
```

The engine-kit tests need the Claude Code CLI, which is not in the lockfile, so CI runs the specs under `spec/` and the engine tests are run locally before each change. The specs parse the binary's golden envelopes in `cmd/3ngram-hook/testdata/commitments/`, so a contract change fails on both sides.
