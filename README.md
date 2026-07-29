<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo/dark.svg">
    <img src="docs/logo/light.svg" alt="3ngram" width="360">
  </picture>

### Persistent, typed memory for AI agents

Decisions, commitments, blockers, and facts that survive the session, across Claude, ChatGPT, Cursor, and your own agents. MCP-first, self-hostable backend, Apache-2.0.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/B3dmar/3ngram/actions/workflows/ci.yml/badge.svg?branch=staging)](https://github.com/B3dmar/3ngram/actions/workflows/ci.yml)
[![recall@5](https://img.shields.io/badge/recall%405-0.9773-brightgreen)](https://docs.3ngram.ai/benchmarks)

[Documentation](https://docs.3ngram.ai) · [Quickstart](https://docs.3ngram.ai/quickstart) · [Self-host](https://docs.3ngram.ai/self-host) · [Benchmarks](https://docs.3ngram.ai/benchmarks) · [Contributing](CONTRIBUTING.md)

</div>

---

3ngram gives your AI tools a memory that outlives the conversation. Memories are **typed**: decisions, commitments, blockers, facts, preferences, patterns, notes, and events each keep their own lifecycle, instead of everything flattening into chat history. They are searchable from any connected client, stored in Postgres with pgvector, and **never silently rewritten**.

- **Append-and-supersede.** Writes never destroy data. Corrections create typed edges between memories, so the old record stays queryable, including "what did I believe on date X".
- **Bi-temporal facts.** Facts track both when they were true in the world and when the system learned them, so retrieval can answer "what is true now" and "what was true then".
- **Knows what it doesn't know.** Retrieval is calibrated to abstain rather than return a confident false match when the answer genuinely isn't stored.
- **A deliberately small surface.** 10 MCP tools and 2 prompts over Streamable HTTP, mirrored on a REST API (`/api/v1`), designed around jobs to be done, not feature count.

## How to run it

| Tier | How | Best for |
|---|---|---|
| **Self-hosted** | `docker compose -f compose.selfhost.yml up` | Full control on your own infrastructure: stock Postgres + pgvector and Redis, no maintainer access, no phone-home. Apache-2.0. |
| **Library** | The `@3ngram/*` packages (core, server, schema, and more) publish to public npm under Apache-2.0 | Building on the memory core, or running the server, inside your own toolchain. |
| **Cloud** | Managed MCP endpoint at [3ngram.ai](https://3ngram.ai) | A zero-ops hosted option. See the [quickstart](https://docs.3ngram.ai/quickstart) to connect a client. |

Everything needed to run the 3ngram memory backend yourself is in this repository. The hosted dashboard and cloud-operations code are proprietary and maintained in a separate private repository; neither is required to use the MCP server, REST API, SDK, or CLI. The REST, authentication, onboarding, and profile routes used by the hosted dashboard remain part of this Apache-licensed server and can be used by other clients.

## Quickstart (self-host)

Stand up the core (MCP server, REST API, Postgres with pgvector, and Redis) with Docker Compose:

```bash
git clone https://github.com/B3dmar/3ngram && cd 3ngram
cp .env.selfhost.example .env.selfhost   # set the required secrets (documented inline)

# migrate the schema and provision the runtime role, then start the stack
docker compose --env-file .env.selfhost -f compose.selfhost.yml run --rm migrations
docker compose --env-file .env.selfhost -f compose.selfhost.yml up -d
```

A fail-closed preflight refuses to boot on blank or placeholder secrets. The server exposes `/health` and the REST API on port `3000`. Seed a golden dataset and mint a demo API key (`3ng_<prefix>_<secret>`) with `pnpm seed`; the full walkthrough is in [Self-host](https://docs.3ngram.ai/self-host).

Before running a search, configure both `LLM_GATEWAY_URL` and `LLM_GATEWAY_API_KEY` in `.env.selfhost` and restart the server. Seeded memories include cached vectors, but the server still needs an embedding provider to embed each query; without one, search returns `503 embedding_unavailable`. Writes still succeed without a gateway, but the memory is stored with a NULL embedding and is **not** queued for automatic backfill — configuring a provider later embeds only subsequent writes, so set the gateway before writing any memory you expect to reach via vector search.

### Published container

The official multi-platform server image supports Linux amd64 and arm64:

```bash
docker pull ghcr.io/b3dmar/3ngram:latest
```

Pin a specific release instead of `latest` with its full version tag, e.g. `docker pull ghcr.io/b3dmar/3ngram:1.0.2`.

Each release also publishes the major/minor (e.g. `1.0`) and `sha-<full-git-sha>` tags, an
SBOM, build provenance, and a GitHub-signed attestation. For immutable digest
pulls and verification, see the [container image guide](https://docs.3ngram.ai/container-image).

### First memory operation

With a running server and an API key, write and search a memory over REST:

```bash
# remember a typed decision
curl -X POST http://localhost:3000/api/v1/memories \
  -H "X-API-Key: 3ng_<prefix>_<secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "memoryType": "decision",
    "topic": "search backend",
    "content": "Use Postgres full-text search for v1.",
    "scope": "work",
    "project": "3ngram"
  }'

# search it back: requires the embedding provider configured above
curl -X POST http://localhost:3000/api/v1/search \
  -H "X-API-Key: 3ng_<prefix>_<secret>" \
  -H "Content-Type: application/json" \
  -d '{ "query": "what did we decide about the search backend?" }'
```

### Connect an MCP client

3ngram is MCP-first. Point an OAuth-capable client at the local server's `/mcp` endpoint:

```bash
claude mcp add --transport http 3ngram-local http://localhost:3000/mcp
```

For the managed service, use `https://mcp.3ngram.ai/mcp` instead. Then ask your client to *remember* something and *search* it back in a later session. The [quickstart guide](https://docs.3ngram.ai/quickstart) covers each client and the OAuth flow.

### Typed TypeScript client

`@3ngram/sdk` is a published, thin typed client over the REST `/api/v1` surface:

```bash
npm install @3ngram/sdk
```

```ts
import { ThreengramClient } from '@3ngram/sdk'

const client = new ThreengramClient({
  baseUrl: 'http://localhost:3000',
  apiKey: process.env.THREENGRAM_API_KEY!,
})

await client.remember({
  memoryType: 'decision',
  topic: 'search backend',
  content: 'Use Postgres full-text search for v1.',
  scope: 'work',
  project: '3ngram',
})

const results = await client.search('what did we decide about the search backend?')
```

## The surface

| Job | Tool |
|---|---|
| Persist something worth keeping | `remember` |
| Find what you know | `search` |
| Correct the record | `revise`, `resolve` |
| Start a session oriented | `briefing` |
| Carry context to another agent | `handoff` |
| What is currently true about X | `get_facts` |
| Organize your memory space | `configure_scope` |
| Review consolidation proposals | `review_proposals` |
| Inspect capabilities and config | `describe_environment` |

Full schemas: [MCP tools](https://docs.3ngram.ai/reference/tools) · [REST API](https://docs.3ngram.ai/api-reference) · [CLI](https://docs.3ngram.ai/reference/cli) · [SDK](https://docs.3ngram.ai/reference/sdk).

## Benchmarks as the goal function

Retrieval quality is invisible to code review, so 3ngram treats its benchmark as a merge gate: a deterministic golden-set eval runs in CI on every change, and a PR that regresses it does not merge. The recorded floors only ratchet upward.

| Metric | Floor |
|---|---|
| recall@5 | 0.9773 |
| MRR@5 | 0.9697 |
| Supersession correctness | 0.9474 |
| Abstention precision | 1.0000 |

Measured over 98 queries across 158 anonymized production memories, including real supersession chains. Supersession is scored with superseded rows still in the index (it proves ranking, not filtering), and abstention on topics that are verifiably absent. Methodology and reproduction: [Benchmarks](https://docs.3ngram.ai/benchmarks) · [`eval/`](eval/).

## How it's built

TypeScript monorepo (Turborepo) · Zod v4 · Drizzle · Express · the official MCP TypeScript SDK · BullMQ · Postgres 18 + pgvector · Redis. Self-host runs the same code on vanilla Postgres + Redis.

The design is documented decision-first in the [Concepts](https://docs.3ngram.ai/concepts/architecture) docs:

- [Architecture](https://docs.3ngram.ai/concepts/architecture) and [Memory model](https://docs.3ngram.ai/concepts/memory-model): append-and-supersede, typed memories, bi-temporal facts
- [Data model](https://docs.3ngram.ai/concepts/data-model) and [MCP server design](https://docs.3ngram.ai/concepts/mcp-design): schema, row-level security, and the tool contract
- [`AGENTS.md`](AGENTS.md): repo rules, commands, and workflow for contributors and AI assistants

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow (DCO sign-off required), [SUPPORT.md](SUPPORT.md) for where to ask questions, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities. All participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

**[Apache-2.0](LICENSE)** for every file in this repository, permanently: the memory engine, MCP server, REST API, SDK, and CLI are all open source and self-hostable. The hosted dashboard and cloud-operations code are proprietary and maintained in a separate private repository; neither is needed to run the 3ngram memory backend. Details: [LICENSING.md](LICENSING.md).
