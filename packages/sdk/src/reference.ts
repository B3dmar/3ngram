// SPDX-License-Identifier: Apache-2.0
// Public SDK reference metadata consumed by the docs generator. The SDK runtime
// surface stays in client.ts; this file keeps docs prose, method signatures, and
// examples explicit without making the generator parse comments.

export interface SdkMethodReference {
  name: string
  signature: string
  route: string
  summary: string
  requestSchema: 'remember' | 'search' | 'facts' | 'revise' | 'resolve'
  responseSchema: 'remember' | 'search' | 'facts' | 'revise' | 'resolve'
  example: string
}

export const SDK_METHOD_NAMES = ['remember', 'search', 'getFacts', 'revise', 'resolve'] as const

export const SDK_METHODS: readonly SdkMethodReference[] = [
  {
    name: 'remember',
    signature: 'remember(input: RememberToolArgs): Promise<RememberToolOutput>',
    route: 'POST /api/v1/memories',
    summary: 'Append a typed memory. Commitment outputs include a commitmentId.',
    requestSchema: 'remember',
    responseSchema: 'remember',
    example: [
      'await client.remember({',
      "  memoryType: 'decision',",
      "  topic: 'search backend',",
      "  content: 'Use Postgres full-text search for v1.',",
      "  scope: 'work',",
      "  project: '3ngram',",
      '})',
    ].join('\n'),
  },
  {
    name: 'search',
    signature: 'search(query: string, opts?: SearchOptions): Promise<SearchRestResponseV2>',
    route: 'POST /api/v1/search',
    summary: 'Run semantic and keyword retrieval with optional pre-fusion filters.',
    requestSchema: 'search',
    responseSchema: 'search',
    example: [
      "await client.search('oauth refresh token', {",
      '  limit: 5,',
      "  scope: 'work',",
      "  project: '3ngram',",
      '})',
    ].join('\n'),
  },
  {
    name: 'getFacts',
    signature: 'getFacts(filters?: FactsQueryArgs): Promise<FactsToolOutput>',
    route: 'GET /api/v1/facts',
    summary: 'Read currently-valid facts, with optional bi-temporal filters.',
    requestSchema: 'facts',
    responseSchema: 'facts',
    example: [
      'await client.getFacts({',
      "  subject: '3ngram',",
      "  predicate: 'status',",
      '  limit: 20,',
      '})',
    ].join('\n'),
  },
  {
    name: 'revise',
    signature: 'revise(predecessorId: string, input: ReviseBody): Promise<ReviseToolOutput>',
    route: 'POST /api/v1/memories/:id/revise',
    summary: 'Create a corrected successor memory and link it to the predecessor.',
    requestSchema: 'revise',
    responseSchema: 'revise',
    example: [
      'await client.revise(memoryId, {',
      "  memoryType: 'decision',",
      "  topic: 'search backend',",
      "  content: 'Use Postgres full-text search plus embeddings for v1.',",
      "  edgeIntent: 'updates',",
      '})',
    ].join('\n'),
  },
  {
    name: 'resolve',
    signature: 'resolve(memoryId: string, status: CommitmentStatus): Promise<ResolveToolOutput>',
    route: 'POST /api/v1/memories/:id/resolve',
    summary: 'Transition the commitment riding a memory, or archive an active blocker.',
    requestSchema: 'resolve',
    responseSchema: 'resolve',
    example: "await client.resolve(memoryId, 'resolved')",
  },
]

export const SDK_ERRORS = [
  {
    name: 'ThreengramApiError',
    description:
      'Thrown for non-2xx REST responses. Carries status, reason, and optional recovery detail from the response body.',
  },
  {
    name: 'ThreengramNetworkError',
    description: 'Thrown when fetch rejects before a server response is available.',
  },
] as const
