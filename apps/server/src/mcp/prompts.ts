// SPDX-License-Identifier: Apache-2.0
// MCP PROMPTS — code-defined templates: 2 today (briefing, debrief).
//
// A PROMPT is a reusable, parameterised message template the client surfaces to
// its user (a slash command, a menu entry); selecting it returns bounded text
// that ORIENTS the agent. It is NOT a tool: a prompt NEVER queries, never touches
// the DB, carries NO tenant data and NO secrets — its only output is the static
// (arg-interpolated) instruction text below. The actual memory work happens when
// the agent, so oriented, calls the briefing/remember TOOLS.
//
// CAPABILITY: McpServer.registerPrompt AUTO-ENABLES the `prompts` capability, so
// prompts/list + prompts/get become available the moment this runs — no edit to
// routes/mcp.ts. That route mounts oauthBearerAuth on router.all('/mcp', ...), so
// prompts/list and prompts/get are Bearer-gated at the transport layer exactly
// like tools/* (prompts have no per-tool scope concept — there is no MCP notion
// of a per-prompt scope, and these templates expose no data, so transport-level
// Bearer auth is the complete access control). Confirmed in routes/mcp.ts.
//
// SURFACE (docs/concepts/mcp-design.mdx): 2 prompts today (briefing, debrief).
// {@link PROMPTS}.length is the auditable count — there is no numeric ceiling.
// A prompt earns its place the same way a tool does: a JTBD no existing surface
// covers, plus scenarios in eval/fixtures/tool-selection.json, whose surface
// slice measures how hard the TOOL descriptions pull on a need that a prompt
// should serve.
//
// ARG TYPING: MCP delivers prompt arguments as STRINGS over the wire, so every
// arg shape is string-valued — z.enum for the bounded selectors/modes. The
// registry wraps that shape into a full Zod Standard Schema object for SDK v2.
//
// SCHEMA ALIGNMENT (hard rule 2 — constraints live in @3ngram/schema): the
// rendered text instructs the agent to call the briefing/remember TOOLS, so the
// prompt's argument vocabulary MUST be exactly what those tools accept. The flat,
// string-valued prompt args cannot be a Zod object, so instead of a hand-rolled
// local enum (which could DRIFT and tell the agent to call a tool with a value it
// rejects) we DERIVE the selector vocabulary from the canonical
// {@link briefingSelectorSchema} discriminator and validate the debrief `scope`
// against the canonical {@link scopeSchema} before rendering.
import { renderDebriefPrompt } from '@3ngram/core'
import {
  briefingModeSchema,
  briefingSelectorSchema,
  projectSchema,
  scopeSchema,
} from '@3ngram/schema'
import { completable, type GetPromptResult, type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { facetCompleter } from './completions.js'
import type { ToolContext } from './tools.js'

/**
 * A code-defined prompt, erased to a name + a server-bound registrar. The arg
 * shape is captured at the typed {@link definePrompt} call site, so the
 * heterogeneous {@link PROMPTS} registry stays name-typed without an `any`-typed
 * arg shape leaking across distinct prompts.
 */
interface RegisterablePrompt {
  name: string
  register: (server: McpServer, ctx: ToolContext) => void
}

/**
 * Define a code-defined prompt. The local raw shape is wrapped once into a full
 * Zod object because SDK v2 registers Standard Schema objects directly.
 * `render` returns the bounded
 * {@link GetPromptResult}: a single user message whose text orients the agent;
 * it receives the SDK-VALIDATED, re-parsed args and reads NOTHING else (no DB,
 * no env). The returned registrar binds the prompt onto an McpServer;
 * registerPrompt auto-enables the `prompts` capability.
 */
function definePrompt<Args extends z.ZodRawShape>(prompt: {
  name: string
  config: {
    title: string
    description: string
    /**
     * Built PER REQUEST from the request's {@link ToolContext} (issue #104): an
     * argument may be wrapped with the SDK's `completable()`, and a completer
     * reads the tenant's own facets, so it needs the verified tenant. Prompts
     * that complete nothing simply ignore the argument.
     */
    argsSchema: (ctx: ToolContext) => Args
  }
  render: (args: z.infer<z.ZodObject<Args>>) => GetPromptResult
}): RegisterablePrompt {
  return {
    name: prompt.name,
    register: (server, ctx) => {
      // The SDK already validates inbound args against `argsObject` before
      // invoking the callback; re-parsing through the same z.object is a
      // zero-risk TYPE BRIDGE that yields the exact `z.infer<z.ZodObject<Args>>`
      // `render` declares (the SDK's structurally-equal arg type does not
      // generically unify with zod's).
      const argsObject = z.object(prompt.config.argsSchema(ctx))
      const config = { ...prompt.config, argsSchema: argsObject }
      server.registerPrompt(prompt.name, config, (args: unknown) =>
        prompt.render(argsObject.parse(args)),
      )
    },
  }
}

/** Wrap orienting text as the single-user-message prompt result. */
function userMessage(text: string): GetPromptResult {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] }
}

// The selector vocabulary the briefing TOOL accepts (no-firehose: a briefing
// REQUIRES an explicit selector). DERIVED from the canonical, discriminated
// {@link briefingSelectorSchema} `kind` literals so the prompt's flat,
// string-valued arg can NEVER drift from the values the tool actually accepts:
// adding/removing a selector kind in @3ngram/schema flows through here for free.
const SELECTOR_KINDS = briefingSelectorSchema.options.map((option) => option.shape.kind.value) as [
  string,
  ...string[],
]

const selectorArgSchema = z
  .enum(SELECTOR_KINDS)
  .describe('Which slice to brief over: a single scope, a single project, or all memories.')

// DERIVED from the canonical {@link briefingModeSchema} so the prompt offers
// exactly the detail levels the briefing TOOL understands.
const modeArgSchema = briefingModeSchema.describe(
  'brief (counts + top items, the default) or full (the bounded lists).',
)

/**
 * briefing — orient the agent to START a session by calling the briefing TOOL
 * with an EXPLICIT selector (no-firehose, docs/concepts/mcp-design.mdx). The prompt TEXT only
 * orients; it does NOT query — the agent then issues the tool call itself. The
 * `selector`/`mode` args interpolate into a concrete, copy-ready instruction.
 */
const briefingPrompt = definePrompt({
  name: 'briefing',
  config: {
    title: 'Session briefing',
    description:
      'Orient yourself at the start of a session: call the briefing TOOL with an explicit selector (no unfiltered default) to surface open/overdue commitments, blockers, stale candidates, recent decisions, and preferences.',
    // No completable argument: `selector` is a closed enum of selector KINDS,
    // not a scope name, so there is nothing tenant-specific to offer. See the
    // note on debrief below.
    argsSchema: () => ({
      selector: selectorArgSchema,
      mode: modeArgSchema.optional(),
    }),
  },
  render({ selector, mode }) {
    const mode_ = mode ?? 'brief'
    const selectorHint =
      selector === 'all'
        ? '{ "kind": "all" }'
        : selector === 'scope'
          ? '{ "kind": "scope", "scope": "<your-scope>" }'
          : '{ "kind": "project", "project": "<your-project>" }'
    return userMessage(
      [
        'Start this session oriented. Call the `briefing` TOOL with an EXPLICIT selector',
        '— there is no unfiltered default (the no-firehose rule), so a selector is required.',
        '',
        `Use selector ${selectorHint} and mode "${mode_}".`,
        '',
        'The tool returns size-disciplined sections: open and overdue commitments,',
        'blockers, stale candidates, recent decisions, and preferences. In "brief" mode',
        'you get counts plus a top slice per section; in "full" mode you get the bounded',
        'lists. Read the result, then proceed with the work already in flight before',
        'starting anything new.',
      ].join('\n'),
    )
  },
})

/**
 * debrief — orient the agent to CLOSE a session by extracting what is worth
 * persisting (decisions, commitments, follow-ups) and writing each via the
 * `remember` TOOL, mirroring the spirit of the debrief skill. The optional
 * `scope` arg names the slice the work belonged to so the persisted memories
 * land tagged correctly. The text orients; it does NOT itself persist anything.
 */
const debriefPrompt = definePrompt({
  name: 'debrief',
  config: {
    title: 'Session debrief',
    description:
      'Close a session cleanly: review what happened, then persist what is worth keeping — one typed atom per remember call, content capped — by calling the remember TOOL for each, and resolve any completed commitments.',
    argsSchema: (ctx) => ({
      // VALIDATED against the canonical {@link scopeSchema} (kebab-case), the SAME
      // constraint the `remember` TOOL enforces — so a scope the prompt accepts is
      // a scope `remember` accepts, and the rendered "tag with scope X" line can
      // never instruct a value the tool would reject (e.g. "Work Notes").
      //
      // COMPLETABLE (issue #104): the client can offer the tenant's ACTUAL scope
      // names instead of making the user recall them, which is the difference
      // between a typo returning nothing and the right slice being one keystroke
      // away. registerPrompt wrapping ANY completable argument auto-enables the
      // `completions` capability.
      //
      // `completable(...)` wraps the INNER schema and `.optional()` is applied
      // after, not the other way round: the SDK unwraps an optional before
      // testing for completability (handlePromptCompletion), and
      // CompleteCallback infers its value type from the schema — wrapping the
      // optional would demand a completer over `string | undefined`.
      scope: completable(
        scopeSchema.describe(
          'Optional scope (kebab-case, e.g. work, personal) the session belonged to.',
        ),
        facetCompleter(ctx, 'scopes'),
      ).optional(),
      // Same pattern for project: a NULL project never matches a project-scoped
      // briefing (issue #166 / session-continuity review). Completes from the
      // tenant's live project facets, same as REST GET /memories/facets.
      project: completable(
        projectSchema.describe(
          'Optional project the session belonged to. Pass it on remember or the memory is invisible to that project briefing.',
        ),
        facetCompleter(ctx, 'projects'),
      ).optional(),
    }),
  },
  // THE SAME renderer GET /api/v1/prompts/debrief serves
  // (packages/core/src/prompts/debrief.ts): 3ngram owns the words and the hook owns the
  // trigger, so the two transports cannot drift. `scope`/`project` are rendered
  // as DELIMITED DATA inside a fenced JSON block rather than interpolated into
  // the imperative sentences — `projectSchema` permits a repo directory name
  // that reads as a command, and this text reaches a tool-capable turn. No
  // tenant data is passed: `briefedCommitments` is the REST render's input, and
  // an MCP prompt carries none (see the module header).
  render({ scope, project }) {
    return userMessage(renderDebriefPrompt({ scope, project }))
  },
})

/**
 * THE code-defined prompt surface — 2 today (briefing, debrief;
 * docs/concepts/mcp-design.mdx). Length === registered count, auditable from this
 * one array. Each entry carries its name (auditable) and a server-bound
 * registrar, so the registry stays type-safe over heterogeneous arg shapes
 * without an `any`.
 */
export const PROMPTS: readonly RegisterablePrompt[] = [briefingPrompt, debriefPrompt]

/**
 * Register every code-defined prompt on the McpServer. Called from
 * {@link createMcpServer} alongside the registerTool loop; registerPrompt
 * auto-enables the `prompts` capability, so prompts/list + prompts/get are served
 * with no transport-route change. The render callback is synchronous and reads
 * only its validated args (no tenant context needed — a prompt carries no data).
 */
export function registerPrompts(server: McpServer, ctx: ToolContext): void {
  for (const prompt of PROMPTS) {
    prompt.register(server, ctx)
  }
}
