// SPDX-License-Identifier: Apache-2.0
// The three commands (3ngram remember|search|facts) over @3ngram/sdk.
// Arg parsing uses node:util parseArgs (BUILT-IN — no CLI-framework dependency).
// Request-body types come from @3ngram/schema (the z.input '*Args' types, where
// defaulted fields are optional), so the CLI invents no shape. The CLI imports
// @3ngram/sdk + @3ngram/schema ONLY — never @3ngram/core or @3ngram/db (layering).

import { parseArgs } from 'node:util'
import type { AsOfInput, FactsQueryArgs, RememberToolArgs } from '@3ngram/schema'
import type { SearchOptions, ThreengramClient } from '@3ngram/sdk'
import { type ConfigFlags, resolveConfig } from './config.js'
import { formatFacts, formatRemember, formatSearch } from './format.js'
import type { Io } from './io.js'
import { CLI_COMMAND_NAMES } from './reference.js'

/** A bad-arguments failure: surfaces a usage message and a non-zero exit. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** parseArgs options common to every command: config flags + the --json switch. */
const COMMON_OPTIONS = {
  'base-url': { type: 'string' },
  'api-key': { type: 'string' },
  json: { type: 'boolean', default: false },
} as const

/** Pull the shared config flags out of a parsed values bag. */
function configFlags(values: Record<string, unknown>): ConfigFlags {
  const flags: ConfigFlags = {}
  if (typeof values['base-url'] === 'string') flags.baseUrl = values['base-url']
  if (typeof values['api-key'] === 'string') flags.apiKey = values['api-key']
  return flags
}

/** Build the client from resolved config and emit either raw JSON or human text. */
function emit(io: Io, json: boolean, payload: unknown, human: string): void {
  io.stdout(json ? JSON.stringify(payload, null, 2) : human)
}

/** Run a command: parse args, build the client, call the SDK, format the result. */
export async function runCommand(command: string, rest: string[], io: Io): Promise<void> {
  try {
    switch (command) {
      case 'remember':
        return await runRemember(rest, io)
      case 'search':
        return await runSearch(rest, io)
      case 'facts':
        return await runFacts(rest, io)
      default:
        throw new UsageError(
          `unknown command '${command}' (expected: ${CLI_COMMAND_NAMES.join(', ')})`,
        )
    }
  } catch (error) {
    throw asUsageError(error)
  }
}

/** Recast a node:util parseArgs rejection (unknown/typo flag) as a UsageError. */
function asUsageError(error: unknown): unknown {
  const code = (error as { code?: unknown }).code
  if (error instanceof Error && typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')) {
    return new UsageError(error.message)
  }
  return error
}

/** Construct the SDK client from the parsed common flags + the injected env. */
function clientFor(values: Record<string, unknown>, io: Io): ThreengramClient {
  return io.makeClient(resolveConfig(configFlags(values), io.env))
}

/** `3ngram remember` — --type/--topic/--content required; optional scope/project/tags. */
async function runRemember(argv: string[], io: Io): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      type: { type: 'string' },
      topic: { type: 'string' },
      content: { type: 'string' },
      scope: { type: 'string' },
      project: { type: 'string' },
      tags: { type: 'string', multiple: true },
    },
    allowPositionals: false,
  })
  const input = rememberArgs(values)
  const result = await clientFor(values, io).remember(input)
  emit(io, values.json === true, result, formatRemember(result))
}

/** Assemble a RememberToolArgs from parsed values; required fields are enforced. */
function rememberArgs(values: Record<string, unknown>): RememberToolArgs {
  const memoryType = requireString(values.type, '--type')
  const topic = requireString(values.topic, '--topic')
  const content = requireString(values.content, '--content')
  const args: RememberToolArgs = {
    memoryType: memoryType as RememberToolArgs['memoryType'],
    topic,
    content,
  }
  if (typeof values.scope === 'string') args.scope = values.scope
  if (typeof values.project === 'string') args.project = values.project
  const tags = parseTags(values.tags)
  if (tags !== undefined) args.tags = tags
  return args
}

/** Tags arrive as repeatable --tags and/or comma-separated; flatten + trim both. */
function parseTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const tags = raw
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split(','))
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '')
  return tags.length === 0 ? undefined : tags
}

/** `3ngram search` — query as positional or --query; optional filter flags. */
async function runSearch(argv: string[], io: Io): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      query: { type: 'string' },
      limit: { type: 'string' },
      type: { type: 'string' },
      scope: { type: 'string' },
      project: { type: 'string' },
      status: { type: 'string' },
    },
    allowPositionals: true,
  })
  const query = searchQuery(values.query, positionals)
  const result = await clientFor(values, io).search(query, searchOptions(values))
  emit(io, values.json === true, result, formatSearch(result))
}

/** Resolve the query string: --query wins, else the single positional; required. */
function searchQuery(flag: unknown, positionals: string[]): string {
  if (typeof flag === 'string' && flag.trim() !== '') return flag
  const [first] = positionals
  if (positionals.length > 1)
    throw new UsageError('search takes one query (quote multi-word queries)')
  if (typeof first === 'string' && first.trim() !== '') return first
  throw new UsageError('search requires a query (positional or --query)')
}

/** Assemble the optional search filters into a SearchOptions narrowing. */
function searchOptions(values: Record<string, unknown>): SearchOptions {
  const opts: SearchOptions = {}
  const limit = parseLimit(values.limit)
  if (limit !== undefined) opts.limit = limit
  if (typeof values.type === 'string') opts.memoryType = values.type as SearchOptions['memoryType']
  if (typeof values.scope === 'string') opts.scope = values.scope
  if (typeof values.project === 'string') opts.project = values.project
  if (typeof values.status === 'string') opts.status = values.status as SearchOptions['status']
  return opts
}

/** `3ngram facts` — optional subject/predicate/valid-at/as-known-at/limit. */
async function runFacts(argv: string[], io: Io): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      subject: { type: 'string' },
      predicate: { type: 'string' },
      'valid-at': { type: 'string' },
      'as-known-at': { type: 'string' },
      limit: { type: 'string' },
    },
    allowPositionals: false,
  })
  const result = await clientFor(values, io).getFacts(factsFilters(values))
  emit(io, values.json === true, result, formatFacts(result))
}

/** Assemble FactsQueryArgs, mapping --valid-at/--as-known-at into the asOf shape. */
function factsFilters(values: Record<string, unknown>): FactsQueryArgs {
  const filters: FactsQueryArgs = {}
  if (typeof values.subject === 'string') filters.subject = values.subject
  if (typeof values.predicate === 'string') filters.predicate = values.predicate
  const limit = parseLimit(values.limit)
  if (limit !== undefined) filters.limit = limit
  const asOf = factsAsOf(values)
  if (asOf !== undefined) filters.asOf = asOf
  return filters
}

/** Map --valid-at/--as-known-at to asOf; undefined when neither is supplied. */
function factsAsOf(values: Record<string, unknown>): AsOfInput | undefined {
  const validAt = typeof values['valid-at'] === 'string' ? values['valid-at'] : undefined
  const asKnownAt = typeof values['as-known-at'] === 'string' ? values['as-known-at'] : undefined
  if (validAt === undefined && asKnownAt === undefined) return undefined
  const asOf: Record<string, string> = {}
  if (validAt !== undefined) asOf.validAt = validAt
  if (asKnownAt !== undefined) asOf.asKnownAt = asKnownAt
  return asOf as AsOfInput
}

/** A required string flag; throws UsageError naming the flag when absent/empty. */
function requireString(value: unknown, flag: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value
  throw new UsageError(`${flag} is required`)
}

/** Parse a numeric --limit flag; throws UsageError when present but not a number. */
function parseLimit(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const limit = Number(value)
  if (!Number.isInteger(limit)) throw new UsageError('--limit must be an integer')
  return limit
}
