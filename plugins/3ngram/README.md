# 3ngram for Claude Code

A read-only commitment panel inside Claude Code. It lists the current project's open, waiting and overdue commitments from your 3ngram memory, says where each came from, and shows related evidence that one may be done. It never changes a record and never adds a backlog.

Tested with Claude Code 2.1.291 and 2.1.292. The plugin API it uses (mods) is early access and can change between releases.

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
- **Rows only with their context.** Every read carries a fingerprint of the backend, the key and the selection. Rows are kept only next to the read that produced them. After a failure they stay, marked stale, only when the failed attempt is verified to be the same context. A failure without an answer is checked with `3ngram-hook commitments context`, which makes no request. Anything else clears the list and the detail view.
- **Unscoped means verified.** A row is labelled unscoped only after its memory is read back with no project; otherwise it is "filing unknown".
- **Owners and sources.** Native writes never record an owner, and the read API does not expose the session a memory was written in, so the panel says "owner unclear (not recorded)" and "source session: not exposed" instead of guessing.
- **Evidence is for review.** A newer memory that updates or supersedes a commitment, a pending proposal touching it, or a merged pull request it mentions is shown as related evidence. "No evidence found in the inspected window" says how far the search looked.
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
