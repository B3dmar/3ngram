# AGENTS.md — instructions for AI coding agents

Canonical contributor + AI-assistant guide for this repo (Claude Code reads it via `CLAUDE.md`; Codex reads it natively). Keep it current — it is the contract for how code is written here.

## What this repo is

3ngram: persistent, typed memory for AI agents — an open-source memory engine,
MCP server, REST API, SDK, CLI, worker, and self-host backend. The managed
dashboard and cloud operations are proprietary and live in `3ngram-platform`.

**Where the design lives:**

- `docs/concepts/` — system design and specs (architecture, data model, MCP design, memory model, scopes, local development, testing).

## Layout

pnpm + Turborepo monorepo (`pnpm-workspace.yaml`).

- `apps/` — `server` (MCP + REST), `worker` (BullMQ jobs), `cli`.
- `packages/` — `schema` (Zod — the single validation boundary), `db` (Drizzle + tenant access), `core` (business logic), `llm`, `config`, `sdk`.
- `eval/` — golden-set evaluation harness.

## Commands

```bash
pnpm install --frozen-lockfile   # never plain install in CI
pnpm build                       # turbo run build
pnpm lint                        # Biome only (biome ci .) — format + no-raw-db rule
pnpm check                       # lint + typecheck (Biome + tsc)
pnpm test                        # unit tests
pnpm test:integration            # integration suites (require an ephemeral DB — see below)
pnpm db:migrate                  # apply Drizzle migrations
```

## Hard rules (lint-enforced where possible, review-enforced otherwise)

Each rule names its enforcement. Where that is **review**, there is no check to hide
behind — say so in the PR description.

1. **Never merge/delete memory data on a write path.** Append-and-supersede only (docs/concepts/memory-model.mdx). Any code that destroys memory rows is a bug by definition. — *Enforcement: **review**, plus the supersession suites in `packages/db` and the eval's `supersession_correct` floor.*
2. **One validation boundary**: enums/constraints live in `packages/schema` (Zod). No re-validation in services; DB CHECKs are generated. — *Enforcement: **review**.*
3. **All DB access through `withTenant()`** (`packages/db`). Raw pool access is banned. Every user-owned table — including relation tables — carries `user_id`; cross-tenant FKs are composite `(user_id, …)`. — *Enforcement: `no-raw-db.grit` (Biome plugin) + `scripts/check-db-access.sh` (path-scoped: no pool/drizzle handle or Postgres driver import outside `packages/db`).*
4. **No `it.skip`/`todo` on main. No flake retries.** A failing test gets fixed or deleted-with-issue (`docs/concepts/testing.mdx`). — *Enforcement: `scripts/check-no-skip.sh` (also catches `.only` and chained modifiers); `scripts/check-db-shards.sh` catches an integration test that no shard runs.*
5. **Layering**: `apps/*` → `packages/core` → `packages/db`. Transports (REST routes, MCP tools) contain zero business logic. 50-line functions, 500-line files. — *Enforcement: **review** (the size limits are targets, not lint rules).*
6. **No memory content in logs/traces/metrics** — IDs, types, lengths, hashes only. — *Enforcement: **review**.*
7. **Supply chain**: `ignore-scripts` stays on; GitHub Actions pinned by full SHA; lockfile frozen. — *Enforcement: `scripts/check-no-lifecycle-scripts.sh`, `scripts/check-action-pins.sh`, `scripts/check-workflow-safety.sh`, `scripts/check-dependency-licenses.mjs`, `scripts/check-override-freshness.mjs` (advisory overrides must still reach the graph), and `--frozen-lockfile` in CI.*
8. **The MCP surface earns its size by evidence, not by a count.** Adding or changing a tool requires: a JTBD no existing tool covers (`docs/concepts/mcp-design.mdx`); a regenerated surface snapshot committed with the change (`pnpm run docs:generate`, plus `eval/fixtures/transport-surfaces.json` and the tool-selection embeddings when a description moves); and its scenarios in `eval/fixtures/tool-selection.json` — exactly 5 agent utterances per registered tool, pinned by a unit test, so a new tool without them fails before the gate even scores. There is no numeric ceiling — `MAX_TOOLS`/`MAX_PROMPTS` were removed once the property they proxied for could be measured, and a twelfth tool is not blocked, only a twelfth tool that reads like an existing one. — *Enforcement: the `eval-gate` required check (floors on `selection_accuracy_at_1`/`selection_margin`, ceiling on `max_description_overlap`); the `docs-reference` byte-for-byte diff for the regenerated snapshot; and `check` — the `quality (unit)` lane's `pnpm test` — for the per-tool scenario count (`eval/test/tool-selection.test.mjs`). The JTBD itself is **review**.*

## Database / env safety

Integration tests run destructive cleanup (`resetDomainTables()` TRUNCATEs domain tables CASCADE). Because of that, a repo-root `.env` pointing a plain `DATABASE_URL` at production can let test setup truncate live data. Rules:

- **Repo-root `.env` must never carry a plain `DATABASE_URL` pointing at production.** For a local reference to prod, use `PROD_DATABASE_URL` (never consumed by tests or the runtime client).
- **Integration tests require a provably ephemeral DB.** Provably ephemeral = host on the loopback allowlist (`localhost`, `127.0.0.1`, `::1`) OR `I_AM_AN_EPHEMERAL_DB=1` is set explicitly. A managed-provider suffix (e.g. `.neon.tech`) is NOT proof of ephemerality — prod is itself a pooled host on the same provider. The guard (`packages/db/test/integration/ephemeral-guard.ts`) checks BOTH `DATABASE_URL` and `DATABASE_URL_UNPOOLED` and aborts loudly before any truncate.
- **Never add a `process.env.DATABASE_URL ||`/`??` fallback in test or setup code** — it routes truncates around the host check. Require the env and fail closed; `scripts/check-db-access.sh` lints for this.

## Workflow

- Branches: `feat/*|fix/*|chore/*` → PR to `staging` → PR `staging` → `main`. Both protected (PR-only, merge commits). PRs < 200 lines where feasible; stack bigger work.
- A PR touching `apps/*` or `packages/*` needs a changeset (publishable libs need release notes too). Docs/test-only: empty changeset.
- Conventional commits: `<type>(<scope>): <subject>`, imperative, ≤ 50 chars.
- A PR that regresses the blocking golden-set eval does not merge — do not "fix" the eval to pass it.
- Every source file carries an SPDX header (`LICENSING.md`).
