# Licensing

3ngram is **open source**: this repository is **100% Apache-2.0**. The hosted service adds a
**proprietary dashboard and cloud-operations code (including billing) that are NOT part of this
repository** — they live in a separate private repo and are never published here. Describe this
repository as "open source" (Apache 2.0): every file in this tree is permissively licensed, while
the hosted dashboard and cloud operations are maintained separately as proprietary software.

## The boundary

Every package/app directory is Apache-2.0; this table is the map.

| Path | License | Rationale |
|---|---|---|
| `packages/schema`, `packages/db`, `packages/core`, `packages/llm`, `packages/config` | **Apache-2.0** | The memory core — everything needed to run 3ngram yourself |
| `apps/server`, `apps/worker`, `apps/cli` | **Apache-2.0** | The self-hostable backend and its command-line surfaces |
| `packages/sdk` (`@3ngram/sdk`) | **Apache-2.0** | Client adoption surface; never encumbered |
| `hooks/`, `eval/`, `docs/` | **Apache-2.0** | Tooling and docs |

The hosted dashboard UI and billing/cloud composition (Stripe Checkout/portal/webhook, the
subscription gate implementation, lifecycle, dunning, and grandfathering) are **proprietary and
live in a separate private repository**. Dashboard-facing REST, authentication, onboarding, and
profile routes remain part of the Apache server: a proprietary client consuming an open API does
not change the license of either side of that boundary.

The Apache server exposes a single neutral `Extension` seam
(`apps/server/src/composition/extension.ts`) defaulting to a no-op. The self-host build composes that
no-op and runs unchanged with zero proprietary dashboard or billing code.

## Rules

1. **Every file is Apache-2.0.** All code in this repository is permissively licensed; nothing here
   is source-restricted or proprietary.
2. **SPDX headers**: every source file carries `// SPDX-License-Identifier: Apache-2.0`; checked by
   the lint job (`scripts/check-spdx.sh`). New files without a header fail `check`.
3. **NOTICE**: the root `NOTICE` file carries attribution; third-party license obligations are
   tracked by an automated license scan in CI (fail on copyleft-incompatible transitive deps).
4. **Contributions**: DCO (`Signed-off-by`) required on all commits once external contributions open
   — no CLA (revisit only if a corporate contributor requires it). All contributions are under
   Apache-2.0.

## Public-facing language (use exactly this framing)

> The 3ngram memory engine, MCP server, REST API, SDK, and CLI are **open source** under Apache 2.0
> and self-hostable. Our hosted dashboard and cloud-operations code, including billing, are
> proprietary and maintained in a separate private repository.
