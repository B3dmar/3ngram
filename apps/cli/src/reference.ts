// SPDX-License-Identifier: Apache-2.0
// Public CLI reference metadata shared by the runtime usage banner and the
// docs generator. Keep command behavior in commands.ts; keep prose and examples
// here so CLI help and docs drift together, not apart.

export interface CliOptionReference {
  name: string
  value?: string
  required?: boolean
  repeatable?: boolean
  description: string
}

export interface CliCommandReference {
  name: string
  usage: string
  summary: string
  sdkCall: string
  requestSchema: 'remember' | 'search' | 'facts'
  responseSchema: 'remember' | 'search' | 'facts'
  options: readonly CliOptionReference[]
  examples: readonly string[]
}

export const CLI_GLOBAL_OPTIONS: readonly CliOptionReference[] = [
  {
    name: '--base-url',
    value: '<url>',
    description: 'REST origin, without /api/v1. Overrides THREENGRAM_BASE_URL.',
  },
  {
    name: '--api-key',
    value: '<key>',
    description: 'API key sent as X-API-Key. Overrides THREENGRAM_API_KEY.',
  },
  {
    name: '--json',
    description: 'Print the raw SDK response instead of human-readable output.',
  },
]

export const CLI_ENV_VARS: readonly CliOptionReference[] = [
  {
    name: 'THREENGRAM_BASE_URL',
    description: 'Default REST origin when --base-url is omitted.',
  },
  {
    name: 'THREENGRAM_API_KEY',
    description: 'Default API key when --api-key is omitted.',
  },
]

export const CLI_COMMAND_NAMES = ['remember', 'search', 'facts'] as const

export const CLI_COMMANDS: readonly CliCommandReference[] = [
  {
    name: 'remember',
    usage: 'remember  --type <t> --topic <t> --content <c> [--scope --project --tags]',
    summary: 'Append a typed memory through the REST-backed SDK client.',
    sdkCall: 'client.remember(input)',
    requestSchema: 'remember',
    responseSchema: 'remember',
    options: [
      {
        name: '--type',
        value: '<memory-type>',
        required: true,
        description:
          'Memory type: decision, commitment, blocker, fact, preference, pattern, note, or event.',
      },
      {
        name: '--topic',
        value: '<topic>',
        required: true,
        description: 'Short title for the memory.',
      },
      {
        name: '--content',
        value: '<text>',
        required: true,
        description: 'Memory body to persist.',
      },
      {
        name: '--scope',
        value: '<scope>',
        description: 'Optional scope such as personal or work.',
      },
      {
        name: '--project',
        value: '<project>',
        description: 'Optional project key for project briefings.',
      },
      {
        name: '--tags',
        value: '<tag[,tag]>',
        repeatable: true,
        description: 'Repeatable; comma-separated values are flattened and trimmed.',
      },
    ],
    examples: [
      '3ngram remember --type decision --topic "search backend" --content "Use Postgres full-text search for v1." --scope work --project 3ngram',
      '3ngram remember --type note --topic "follow-up" --content "Check docs freshness gate." --tags docs,ci --json',
    ],
  },
  {
    name: 'search',
    usage: 'search    <query> [--limit --type --scope --project --status]',
    summary: 'Search memories with optional filters before result fusion.',
    sdkCall: 'client.search(query, options)',
    requestSchema: 'search',
    responseSchema: 'search',
    options: [
      {
        name: '<query>',
        required: true,
        description: 'Positional search text. Quote multi-word queries.',
      },
      {
        name: '--query',
        value: '<query>',
        description: 'Alternative to the positional query; wins when both are present.',
      },
      { name: '--limit', value: '<n>', description: 'Maximum result count.' },
      { name: '--type', value: '<memory-type>', description: 'Maps to the SDK memoryType filter.' },
      { name: '--scope', value: '<scope>', description: 'Restrict search to one scope.' },
      { name: '--project', value: '<project>', description: 'Restrict search to one project.' },
      {
        name: '--status',
        value: '<active|archived>',
        description: 'Filter by supersession-aware memory status.',
      },
    ],
    examples: [
      '3ngram search "oauth refresh token" --scope work --project 3ngram --limit 5',
      '3ngram search --query "design decision" --type decision --json',
    ],
  },
  {
    name: 'facts',
    usage: 'facts     [--subject --predicate --valid-at --as-known-at --limit]',
    summary: 'Read currently-valid facts, optionally with bi-temporal filters.',
    sdkCall: 'client.getFacts(filters)',
    requestSchema: 'facts',
    responseSchema: 'facts',
    options: [
      { name: '--subject', value: '<subject>', description: 'Restrict facts to one subject.' },
      {
        name: '--predicate',
        value: '<predicate>',
        description: 'Restrict facts to one predicate.',
      },
      {
        name: '--valid-at',
        value: '<iso-date>',
        description: 'World-time coordinate for bi-temporal lookup.',
      },
      {
        name: '--as-known-at',
        value: '<iso-date>',
        description: 'Knowledge-time coordinate for bi-temporal lookup.',
      },
      { name: '--limit', value: '<n>', description: 'Maximum fact count.' },
    ],
    examples: [
      '3ngram facts --subject 3ngram --predicate status',
      '3ngram facts --subject "search backend" --valid-at 2026-06-01T00:00:00.000Z --json',
    ],
  },
]
