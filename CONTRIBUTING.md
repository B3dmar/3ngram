# Contributing to 3ngram

Thanks for your interest in contributing. 3ngram is persistent, typed memory
for AI agents (memory engine + MCP server + REST API). This guide covers local
setup, the CI gates your change must pass, and the legal terms for
contributions.

Please also read [`AGENTS.md`](AGENTS.md) — it is the canonical source of
truth for repo rules, hard constraints, and workflow. This document is the
contributor-facing summary.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you agree to uphold it. Report unacceptable behavior through
[GitHub private vulnerability reporting](https://github.com/B3dmar/3ngram/security/advisories/new).

## Development setup

Prerequisites: **Node.js >= 22** and **pnpm 11.9.0** (the repo pins its package
manager via the `packageManager` field — use Corepack or install the matching
pnpm). This is a pnpm + Turborepo monorepo.

```bash
pnpm install --frozen-lockfile   # never plain `install` — match the lockfile
pnpm build                       # turbo run build across all packages
pnpm check                       # turbo run check (types, lint rules, guards)
pnpm test                        # turbo run test (unit suites)
```

Integration tests run destructive cleanup (`resetDomainTables()` truncates
domain tables) and therefore require a **provably ephemeral** database. Only
loopback hosts (`localhost`, `127.0.0.1`, `::1`) are ephemeral by host; any
remote DB must set `I_AM_AN_EPHEMERAL_DB=1` explicitly. Never add a
`process.env.DATABASE_URL ||`/`??` fallback in test or setup code — it routes
truncates around the host check. See `AGENTS.md` for the full incident context.

## Contribution intake (please read first)

3ngram is maintained by a single person (see [`MAINTAINERS.md`](MAINTAINERS.md)),
so review capacity is finite and contributions are managed deliberately:

- **Open an issue before starting a non-trivial PR** so scope and approach can be
  agreed up front. This saves you from building something that won't be merged.
- **Unsolicited or large PRs may be closed** without a full review if they were
  not discussed first. Small, obvious fixes (typos, clear bugs) are welcome
  directly.
- Questions and help requests belong in [Discussions](https://github.com/B3dmar/3ngram/discussions),
  not Issues — see [`SUPPORT.md`](SUPPORT.md).

## Branch & PR workflow

- `main` and `staging` are protected — no direct pushes. Branch, then open a PR.
- Target **`staging`** with your PR (`main` <- `staging` <- `feat/*` | `fix/*` | `chore/*`).
- Branch naming: `feat/<description>`, `fix/<description>`, `chore/<description>`.
- Keep PRs small and reviewable. For larger changes, use stacked PRs.
- Commits: `<type>(<scope>): <subject>` — imperative mood, <=50-char subject.

## CI gates

Every PR must pass the `ci` workflow (`.github/workflows/ci.yml`). The protected-branch ruleset requires three stable status contexts: `check`, `test`, and `eval-gate`. The workflow fans out into faster non-required lanes underneath those contexts; the required aggregators fail closed if any mandatory lane fails.

**`check` context:** aggregates the quality lanes:

1. **Hygiene:** action pinning, SPDX headers, DB-access guard, no-skip guard, changeset guard for PRs, and DCO sign-off for external fork PRs.
2. **Format + lint:** `pnpm exec biome ci .`.
3. **Workspace checks:** `pnpm exec turbo run check`.
4. **Unit tests:** `pnpm run test`.
5. **Docs reference freshness:** `pnpm run docs:generate` then `git diff --exit-code -- docs`.
6. **Go hook gate:** when `cmd/3ngram-hook/**` or `ci.yml` changes, run `gofmt`, `go vet ./...`, `go test ./...`, and the 4-target cross-compile with checksums.

**`eval-gate` context:** the deterministic golden-set gate — `node eval/src/run.mjs --model openai-large-1536`, cosine scores vs ratchet floors, no network or DB.

**`test` context** (PRs only): aggregates real-database integration shards. Each active shard gets a disposable local Postgres service container with pgvector, then migrates, provisions roles, runs owner/runtime smoke checks, and runs its selected integration suite. DB changes split across `db-structure`, `db-search`, `db-auth`, and `db-memory`; core and server changes run their package integration shards. Known docs, CLI, worker, SDK, eval, and Go-only changes skip the database shards through the required aggregator; unknown integration-relevant paths fail safe by running all shards, including all DB slices. The CI path is fork-friendly and needs no hosted-database credentials.

You can reproduce the non-DB gates locally before pushing:

```bash
pnpm install --frozen-lockfile
bash scripts/check-action-pins.sh
bash scripts/check-spdx.sh
bash scripts/check-db-access.sh --self-test && bash scripts/check-db-access.sh
bash scripts/check-no-skip.sh --self-test && bash scripts/check-no-skip.sh
pnpm exec biome ci .
pnpm exec turbo run check
pnpm run test
pnpm run docs:generate && git diff --exit-code -- docs
```

## PR checklist

- [ ] Branched off `staging`; PR targets `staging`.
- [ ] Commits are signed off (`git commit -s` — see DCO below).
- [ ] New source files carry an `SPDX-License-Identifier:` header.
- [ ] GitHub Actions (if touched) pinned by full commit SHA.
- [ ] No `.skip` / `.todo` / `.only` tests.
- [ ] Changeset added if the PR touches `apps/*` or `packages/*`.
- [ ] `docs` regenerated if generated docs changed.
- [ ] All CI gates green.

## Developer Certificate of Origin (DCO)

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/).
**DCO sign-off is required on every commit; there is no CLA** (per
[`LICENSING.md`](LICENSING.md) §5).

Sign off by adding a `Signed-off-by` trailer to each commit. The `-s` flag does
this for you using your configured `user.name` and `user.email`:

```bash
git commit -s -m "feat(scope): add the thing"
```

This appends a trailer like:

```
Signed-off-by: Your Name <you@example.com>
```

By signing off you certify that you wrote the contribution or otherwise have the
right to submit it under the project's license (the full text is the DCO linked
above). Per [`LICENSING.md`](LICENSING.md) §5, sign-off is enforced in CI for
**external (fork) contributions**: the `check` job of `.github/workflows/ci.yml`
runs a DCO step on fork PRs that checks every commit in the PR range introducing
content (non-merge commits, plus any merge commit carrying its own
conflict-resolution edits) and fails if any lacks the trailer. Maintainers
working on internal branches sign off by convention; the gate does not run on
internal PRs (which cannot rewrite already-merged protected-branch commits).
To sign off an existing commit, amend it (`git commit --amend -s --no-edit`) or
rebase with `--signoff` over the range.

## Licensing & the contribution boundary

3ngram is **open source** — Apache-2.0 throughout (see [`LICENSING.md`](LICENSING.md)):

- **Apache-2.0 is the license for everything in this repo.** The memory core,
  server, worker, CLI, SDK, tooling, and docs are all Apache-2.0 (OSI open
  source). Every file here is permissively licensed; describe this repository as
  "open source".
- The hosted dashboard UI and cloud-operations code (including billing) are
  **proprietary**, live in a **separate private repository**, and are not accepted
  as contributions here. Dashboard-facing API routes remain part of the Apache
  server and are in scope for contributions to this repository.
- All contributions are made under Apache-2.0.
- Every new source file must carry an SPDX header
  (`// SPDX-License-Identifier: Apache-2.0`).

## Questions & support

- **Questions, setup help, ideas** → [GitHub Discussions](https://github.com/B3dmar/3ngram/discussions).
  See [`SUPPORT.md`](SUPPORT.md) for the full routing.
- **Reproducible bugs / concrete feature requests** → [open an issue](https://github.com/B3dmar/3ngram/issues)
  with the relevant template.
- **Security or conduct concerns** → [private vulnerability reporting](https://github.com/B3dmar/3ngram/security/advisories/new)
  ([`SECURITY.md`](SECURITY.md)), never a public issue.
