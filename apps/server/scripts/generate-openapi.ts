// SPDX-License-Identifier: Apache-2.0
// OpenAPI 3.1 generator for the REST /api/v1 mirror.
// Includes GET /memories/facets endpoint.
// Consumes the SAME @3ngram/schema Zod exports the routes parse with (hard rule
// 2 — never redeclare shapes) and writes a committed, deterministic spec to
// docs/api-reference/openapi.json (sorted keys, no timestamps). The committed
// spec is the Mintlify deploy trigger; CI regenerates and diffs (freshness gate).
//
// The ROUTES table below is hand-maintained (router.ts registers plain Express
// handlers — there is no declarative route registry to introspect), so
// assertRouteCoverage() parses the REST route modules and FAILS when a
// registered route is missing from the table (or vice versa) — a new route
// cannot silently drop from the published reference.
//
// Platform-only values (the servers base URL) are injected HERE at export time —
// runtime schemas stay free of platform URLs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  accountDeleteBodySchema,
  archiveMemoryBodySchema,
  asOfSchema,
  BRIEFING_SECTION_NAMES,
  briefingModeSchema,
  briefingSelectorV2Schema,
  briefingToolInputV3Schema,
  briefingToolOutputV4Schema,
  budgetStatusResponseSchema,
  dashboardSearchQuerySchema,
  dashboardSearchResponseV2Schema,
  factsQueryInputV2Schema,
  factsRangeSchema,
  factsToolOutputSchema,
  invalidInputRestErrorResponseSchema,
  memoriesFacetsResponseSchema,
  memoriesListQuerySchema,
  memoriesListResponseSchema,
  memoryDetailSchema,
  memoryHistoryResponseSchema,
  memoryStatusSchema,
  meResponseSchema,
  proposalRecordSchema,
  proposalRejectBodySchema,
  proposalStatusSchema,
  proposalsListQuerySchema,
  rememberToolInputV2Schema,
  rememberToolOutputV2Schema,
  resolveToolInputSchema,
  resolveToolOutputSchema,
  retrievalScopeModeSchema,
  reviseToolInputSchema,
  reviseToolOutputSchema,
  scopeNameSchema,
  searchQuerySchema,
  searchRestResponseV2Schema,
  statsResponseSchema,
  versionResponseSchema,
} from '@3ngram/schema'
import { z } from 'zod'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTER_SOURCES = [
  resolve(HERE, '../src/rest/router.ts'),
  resolve(HERE, '../src/rest/search-router.ts'),
] as const
const OUT_FILE = resolve(HERE, '../../../docs/api-reference/openapi.json')
/** Export-time injection only — never declared in runtime code. */
const SERVERS = [{ url: 'https://api.3ngram.ai', description: '3ngram platform' }]

// GET /api/v1/facts flattens the nested asOf AND range objects into flat query
// keys (router.ts reshapes both before the single parse) — compose the
// documented query contract from the SAME exports, never redeclared.
// factsQueryInputV2Schema carries a superRefine (range/asOf mutual exclusion +
// inverted-range check), and zod rejects `.omit()` on a refined object schema,
// so the base shape is rebuilt into a fresh (refinement-free) object first —
// same reason briefingQueryShape below is assembled field-by-field rather than
// derived via `.omit()` off a refined schema.
const factsQuery = z.object({
  ...z.object({ ...factsQueryInputV2Schema.shape }).omit({ asOf: true, range: true }).shape,
  ...asOfSchema.shape,
  ...factsRangeSchema.shape,
})

// GET /api/v1/briefing flattens the selector union into flat keys: `kind` is the
// union discriminator; the per-kind value fields become optional query params.
// Selector V2 (issue #46): the union includes `scope_project`, whose
// `includeUnscoped` boolean arrives as the literal string true/false (router.ts
// coerces exactly those two before the single parse).
const briefingQueryShape: Record<string, z.ZodType> = {
  kind: z.enum(
    briefingSelectorV2Schema.options.map((option) => option.shape.kind.value) as [
      string,
      ...string[],
    ],
  ),
}
for (const option of briefingSelectorV2Schema.options) {
  for (const [key, value] of Object.entries(option.shape)) {
    if (key !== 'kind') briefingQueryShape[key] = (value as z.ZodType).optional()
  }
}
briefingQueryShape.mode = briefingModeSchema.optional()
// Bounds V2 (issue #45): `sections` rides the querystring comma-separated
// (router.ts splits before the single V2 parse — a querystring has no natural
// array); `sectionLimit` reuses the EXACT V2 input field (hard rule 2).
briefingQueryShape.sections = z
  .string()
  .describe(
    `Comma-separated subset of sections to compute (unique names from: ${BRIEFING_SECTION_NAMES.join(', ')}). Absent = all sections; un-requested sections are skipped and omitted from the result.`,
  )
  .optional()
briefingQueryShape.sectionLimit = briefingToolInputV3Schema.shape.sectionLimit

/** Proposal decision echo ({id,status}) — composed from schema exports. */
const proposalDecision = z.object({ id: z.uuid(), status: proposalStatusSchema }).strict()
/** Archive echo ({id,status:'archived'}) — the status literal is EXTRACTED from
 * memoryStatusSchema (hard rule 2: never redeclare an enum member). */
const archiveResult = z
  .object({ id: z.uuid(), status: memoryStatusSchema.extract(['archived']) })
  .strict()
/** GET /api/v1/proposals envelope — the bounded list + count-consistent count. */
const proposalsList = z
  .object({ proposals: z.array(proposalRecordSchema), count: z.number().int().min(0) })
  .strict()
/** GET /api/v1/scopes envelope — registered scope registry rows + count. */
const scopeRow = z
  .object({
    id: z.uuid(),
    name: z.string(),
    aliases: z.array(z.string()),
    createdAt: z.string().datetime(),
  })
  .strict()
const scopesList = z.object({ scopes: z.array(scopeRow), count: z.number().int().min(0) }).strict()

// GET /api/v1/export envelope — the complete portable dataset. Composed here
// from the route's output shape (like scopesList /
// proposalsList above); content-bearing because the archive is the owner's JTBD.
const exportAccount = z
  .object({
    id: z.uuid(),
    email: z.email(),
    emailVerifiedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
const exportMemory = z
  .object({
    id: z.uuid(),
    memoryType: z.string(),
    topic: z.string(),
    content: z.string(),
    scope: z.string(),
    project: z.string().nullable(),
    status: z.string(),
    tags: z.array(z.string()),
    validFrom: z.string().datetime(),
    validTo: z.string().datetime().nullable(),
    recordedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
const exportFact = z
  .object({
    id: z.uuid(),
    memoryId: z.uuid(),
    subject: z.string(),
    predicate: z.string(),
    value: z.string(),
    confidence: z.number().nullable(),
    validFrom: z.string().datetime(),
    validTo: z.string().datetime().nullable(),
    recordedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict()
const exportCommitment = z
  .object({
    id: z.uuid(),
    memoryId: z.uuid(),
    status: z.string(),
    owner: z.string().nullable(),
    dueAt: z.string().datetime().nullable(),
    recurrence: z.unknown(),
    nextSurfacingAt: z.string().datetime().nullable(),
    resolvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
const exportEdge = z
  .object({
    id: z.uuid(),
    fromId: z.uuid(),
    toId: z.uuid(),
    edgeType: z.string(),
    createdBy: z.string(),
    createdAt: z.string().datetime(),
  })
  .strict()
const exportMemoryEvent = z
  .object({
    id: z.uuid(),
    memoryId: z.uuid(),
    eventKind: z.string(),
    actorKind: z.string(),
    payload: z.unknown(),
    createdAt: z.string().datetime(),
  })
  .strict()
const exportProposal = z
  .object({
    id: z.uuid(),
    fromId: z.uuid(),
    toId: z.uuid(),
    edgeType: z.string(),
    memoryType: z.string(),
    similarity: z.number(),
    rationale: z.string().nullable(),
    status: z.string(),
    decidedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict()
// Staged fact proposals awaiting review: the extractor's candidate
// subject/predicate/value plus its rationale. No recordedAt (a proposal is not
// yet an assertion) and a nullable validity window (the reviewer supplies it on
// accept), unlike exportFact above.
const exportFactProposal = z
  .object({
    id: z.uuid(),
    memoryId: z.uuid(),
    subject: z.string(),
    predicate: z.string(),
    value: z.string(),
    confidence: z.number().nullable(),
    validFrom: z.string().datetime().nullable(),
    validTo: z.string().datetime().nullable(),
    memoryType: z.string(),
    rationale: z.string().nullable(),
    status: z.string(),
    decidedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict()
const exportAgentSession = z
  .object({
    id: z.uuid(),
    agent: z.string(),
    sessionId: z.string(),
    source: z.string(),
    project: z.string().nullable(),
    scope: z.string().nullable(),
    selector: z.unknown(),
    openedAt: z.string().datetime(),
    closedAt: z.string().datetime().nullable(),
    lastSeenAt: z.string().datetime(),
    activationEpoch: z.number().int(),
    triageStatus: z.string(),
    triageAttemptId: z.uuid().nullable(),
    lastTriagedEventIds: z.array(z.uuid()),
    briefingDeliveredAt: z.string().datetime().nullable(),
    briefedMemories: z.array(
      z
        .object({
          id: z.uuid(),
          topic: z.string(),
          status: z.string(),
        })
        .strict(),
    ),
    lastMessageExcerpt: z.string().nullable(),
  })
  .strict()
// Cost/usage rows — user-owned tables (user_budgets / llm_usage), RLS-scoped like
// the rest of the archive. Numeric USD columns surface as decimal strings (drizzle
// numeric); usage rows carry no content (hard rule 6).
const exportBudget = z
  .object({
    id: z.uuid(),
    capUsdOverride: z.string().nullable(),
    periodStart: z.string().datetime().nullable(),
    periodEnd: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict()
const exportLlmUsage = z
  .object({
    id: z.uuid(),
    operation: z.string(),
    model: z.string(),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    costUsd: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict()
// Onboarding "About you" profiling answers; a single nullable row —
// null when the user never answered. Free-text columns, not enums (the PUT route is
// the one validation boundary), so each surfaces as a nullable string here.
const exportUserProfile = z
  .object({
    role: z.string().nullable(),
    useCase: z.string().nullable(),
    aiTools: z.array(z.string()).nullable(),
    referralSource: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
// Stored retrieval policy in the portability archive. The row itself carries
// internal creation metadata, but the REST contract exposes only the effective
// policy and its last-update time.
const exportRetrievalPolicy = z
  .object({
    mode: retrievalScopeModeSchema,
    defaultScope: scopeNameSchema.nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict()
const accountExport = z
  .object({
    format: z.literal('3ngram.account-export.v1'),
    exportedAt: z.string().datetime(),
    account: exportAccount,
    memories: z.array(exportMemory),
    facts: z.array(exportFact),
    commitments: z.array(exportCommitment),
    scopes: z.array(scopeRow),
    edges: z.array(exportEdge),
    memoryEvents: z.array(exportMemoryEvent),
    proposals: z.array(exportProposal),
    factProposals: z.array(exportFactProposal),
    agentSessions: z.array(exportAgentSession),
    userBudgets: z.array(exportBudget),
    llmUsage: z.array(exportLlmUsage),
    profile: exportUserProfile.nullable(),
    retrievalPolicy: exportRetrievalPolicy.nullable(),
    counts: z
      .object({
        memories: z.number().int().min(0),
        facts: z.number().int().min(0),
        commitments: z.number().int().min(0),
        scopes: z.number().int().min(0),
        edges: z.number().int().min(0),
        memoryEvents: z.number().int().min(0),
        proposals: z.number().int().min(0),
        factProposals: z.number().int().min(0),
        agentSessions: z.number().int().min(0),
        userBudgets: z.number().int().min(0),
        llmUsage: z.number().int().min(0),
      })
      .strict(),
  })
  .strict()

// DELETE /api/v1/account response — counts-only erasure receipt.
// Mirrors the router's { deleted, alreadyDeleted, erased } envelope;
// content-free per hard rule 6.
const accountDeletion = z
  .object({
    deleted: z.literal(true),
    alreadyDeleted: z.boolean(),
    erased: z
      .object({
        memories: z.number().int().min(0),
        facts: z.number().int().min(0),
        commitments: z.number().int().min(0),
        proposals: z.number().int().min(0),
        factProposals: z.number().int().min(0),
        agentSessions: z.number().int().min(0),
        sessionsDeleted: z.number().int().min(0),
        apiKeysRevoked: z.number().int().min(0),
        oauthTokensRevoked: z.number().int().min(0),
        oauthCodesDeleted: z.number().int().min(0),
        passwordResetTokensDeleted: z.number().int().min(0),
        emailVerificationTokensDeleted: z.number().int().min(0),
      })
      .strict(),
  })
  .strict()

interface RouteDoc {
  method: 'get' | 'post' | 'delete'
  /** The Express path EXACTLY as registered in router.ts (coverage-checked). */
  path: string
  operationId: string
  summary: string
  query?: z.ZodObject
  body?: z.ZodType
  /** True when the route accepts an omitted body (router parses `req.body ?? {}`). */
  optionalBody?: boolean
  status: number
  response?: z.ZodType
  errors?: readonly {
    status: number
    description: string
    reasons?: readonly string[]
    response?: z.ZodType
  }[]
}

/** Every /api/v1 route. assertRouteCoverage() keeps this table honest. */
// biome-ignore format: one route per line keeps the table auditable against router.ts
const ROUTES: readonly RouteDoc[] = [
  { method: 'post', path: '/api/v1/memories', operationId: 'remember', summary: 'Append a new memory (mirrors the MCP remember tool)', body: rememberToolInputV2Schema, status: 201, response: rememberToolOutputV2Schema, errors: [{ status: 409, description: 'The content is already live or the live-memory resource limit has been reached', reasons: ['duplicate_memory', 'resource_limit_exceeded'] }] },
  { method: 'get', path: '/api/v1/memories', operationId: 'listMemories', summary: 'List memories (bounded; identity fields only, never content)', query: memoriesListQuerySchema, status: 200, response: memoriesListResponseSchema },
  { method: 'get', path: '/api/v1/memories/facets', operationId: 'getMemoryFacets', summary: 'Distinct scope and project values for the tenant (filter population)', status: 200, response: memoriesFacetsResponseSchema },
  { method: 'get', path: '/api/v1/memories/:id', operationId: 'getMemory', summary: 'Inspect a single memory, including content', status: 200, response: memoryDetailSchema },
  { method: 'get', path: '/api/v1/memories/:id/history', operationId: 'getMemoryHistory', summary: 'Inspect memory lineage, direct relationships, and audit metadata', status: 200, response: memoryHistoryResponseSchema },
  { method: 'post', path: '/api/v1/search', operationId: 'search', summary: 'Unified semantic + keyword retrieval (mirrors the MCP search tool)', body: searchQuerySchema, status: 200, response: searchRestResponseV2Schema, errors: [{ status: 400, description: 'Invalid search input; detail names retryable scopes when retrieval policy requires one', response: invalidInputRestErrorResponseSchema }] },
  { method: 'post', path: '/api/v1/dashboard/search', operationId: 'dashboardSearch', summary: 'Dashboard search continuation with identity-only hits', body: dashboardSearchQuerySchema, status: 200, response: dashboardSearchResponseV2Schema, errors: [{ status: 400, description: 'Invalid search input or continuation cursor; detail names retryable scopes when retrieval policy requires one', response: invalidInputRestErrorResponseSchema }] },
  { method: 'get', path: '/api/v1/facts', operationId: 'getFacts', summary: 'Currently-valid facts, with optional bi-temporal time travel (mirrors the MCP get_facts tool)', query: factsQuery, status: 200, response: factsToolOutputSchema },
  { method: 'get', path: '/api/v1/briefing', operationId: 'briefing', summary: 'Session briefing over an explicit selector (mirrors the MCP briefing tool)', query: z.object(briefingQueryShape), status: 200, response: briefingToolOutputV4Schema, errors: [{ status: 400, description: 'Invalid briefing input; detail names retryable scopes when retrieval policy requires one', response: invalidInputRestErrorResponseSchema }] },
  { method: 'post', path: '/api/v1/memories/:id/revise', operationId: 'revise', summary: 'Supersede a memory with a corrected successor (mirrors the MCP revise tool)', body: reviseToolInputSchema.omit({ predecessorId: true }), status: 200, response: reviseToolOutputSchema },
  { method: 'post', path: '/api/v1/memories/:id/resolve', operationId: 'resolve', summary: 'Transition the commitment riding a memory (mirrors the MCP resolve tool)', body: resolveToolInputSchema.omit({ memoryId: true }), status: 200, response: resolveToolOutputSchema },
  { method: 'post', path: '/api/v1/memories/:id/archive', operationId: 'archiveMemory', summary: 'Archive an active memory (REST-only lifecycle operation; no MCP mirror)', body: archiveMemoryBodySchema, optionalBody: true, status: 200, response: archiveResult },
  { method: 'get', path: '/api/v1/proposals', operationId: 'listProposals', summary: 'List consolidation proposals (bounded)', query: proposalsListQuerySchema, status: 200, response: proposalsList },
  { method: 'post', path: '/api/v1/proposals/:id/apply', operationId: 'applyProposal', summary: 'Accept a consolidation proposal', status: 200, response: proposalDecision },
  { method: 'post', path: '/api/v1/proposals/:id/reject', operationId: 'rejectProposal', summary: 'Reject a consolidation proposal', body: proposalRejectBodySchema, optionalBody: true, status: 200, response: proposalDecision },
  { method: 'get', path: '/api/v1/scopes', operationId: 'listScopes', summary: 'List the tenant\'s registered scope names', status: 200, response: scopesList },
  { method: 'get', path: '/api/v1/stats', operationId: 'getStats', summary: 'Bounded count aggregates (counts only, never content)', status: 200, response: statsResponseSchema },
  { method: 'get', path: '/api/v1/me', operationId: 'getMe', summary: 'The authenticated identity', status: 200, response: meResponseSchema },
  { method: 'get', path: '/api/v1/budget', operationId: 'getBudget', summary: 'The caller\'s current budget status (effective cap + spend this cycle)', status: 200, response: budgetStatusResponseSchema },
  { method: 'get', path: '/api/v1/version', operationId: 'getVersion', summary: 'The running server build (deploy verification)', status: 200, response: versionResponseSchema },
  { method: 'get', path: '/api/v1/export', operationId: 'exportAccount', summary: 'Download the caller\'s complete data archive (GDPR Art. 20 portability)', status: 200, response: accountExport },
  { method: 'delete', path: '/api/v1/account', operationId: 'deleteAccount', summary: 'Self-serve account deletion: erase PII in place and revoke credentials (GDPR Art. 17 erasure)', body: accountDeleteBodySchema, status: 200, response: accountDeletion },
]

/**
 * COVERAGE ASSERTION: parse every REST route module for registrations and fail
 * when their set differs from ROUTES.
 */
function assertRouteCoverage(): void {
  const registered = new Set<string>()
  for (const sourcePath of ROUTER_SOURCES) {
    const source = readFileSync(sourcePath, 'utf8')
    for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      registered.add(`${match[1]} ${match[2]}`)
    }
  }
  const documented = new Set(ROUTES.map((route) => `${route.method} ${route.path}`))
  const missing = [...registered].filter((entry) => !documented.has(entry))
  const stale = [...documented].filter((entry) => !registered.has(entry))
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `openapi route table out of sync with REST modules — missing: [${missing.join(', ')}] stale: [${stale.join(', ')}]`,
    )
  }
}

/** Convert a Zod schema to a JSON Schema fragment (draft 2020-12 = OpenAPI 3.1). */
function toJson(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' })
  delete json.$schema
  return json
}

/** Recursively sort object keys so the committed artifact is byte-deterministic. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    )
  }
  return value
}

function buildOperation(route: RouteDoc): Record<string, unknown> {
  const parameters: Record<string, unknown>[] = []
  for (const segment of route.path.split('/')) {
    if (segment.startsWith(':')) {
      parameters.push({
        name: segment.slice(1),
        in: 'path',
        required: true,
        schema: toJson(z.uuid(), 'input'),
      })
    }
  }
  if (route.query !== undefined) {
    const json = toJson(route.query, 'input')
    const required = (json.required as string[] | undefined) ?? []
    for (const [name, schema] of Object.entries(json.properties as Record<string, unknown>)) {
      parameters.push({ name, in: 'query', required: required.includes(name), schema })
    }
  }
  return {
    operationId: route.operationId,
    summary: route.summary,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(route.body === undefined
      ? {}
      : {
          requestBody: {
            required: route.optionalBody !== true,
            content: { 'application/json': { schema: toJson(route.body, 'input') } },
          },
        }),
    responses: {
      [String(route.status)]: {
        description: 'Success',
        ...(route.response === undefined
          ? {}
          : { content: { 'application/json': { schema: toJson(route.response, 'output') } } }),
      },
      ...Object.fromEntries(
        (route.errors ?? []).map((error) => [
          String(error.status),
          {
            description: error.description,
            content: {
              'application/json': {
                schema:
                  error.response === undefined
                    ? {
                        type: 'object',
                        properties: { error: { type: 'string', enum: error.reasons } },
                        required: ['error'],
                        additionalProperties: false,
                      }
                    : toJson(error.response, 'output'),
              },
            },
          },
        ]),
      ),
    },
  }
}

function main(): void {
  assertRouteCoverage()
  const paths: Record<string, Record<string, unknown>> = {}
  for (const route of ROUTES) {
    const oasPath = route.path.replace(/:([A-Za-z]+)/g, '{$1}')
    paths[oasPath] = { ...paths[oasPath], [route.method]: buildOperation(route) }
  }
  const document = {
    openapi: '3.1.0',
    info: {
      title: '3ngram REST API',
      description:
        'The /api/v1 REST mirror of the 3ngram memory core (docs/concepts/architecture.mdx: one core, N transports). Authenticate with an X-API-Key header or a session Bearer token.',
      version: 'v1',
    },
    servers: SERVERS,
    security: [{ apiKey: [] }, { sessionBearer: [] }],
    paths,
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        sessionBearer: { type: 'http', scheme: 'bearer' },
      },
    },
  }
  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(OUT_FILE, `${JSON.stringify(sortKeys(document), null, 2)}\n`)
  process.stdout.write(`openapi: wrote ${ROUTES.length} routes to ${OUT_FILE}\n`)
}

main()
