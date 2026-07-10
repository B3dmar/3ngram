// SPDX-License-Identifier: Apache-2.0
// MCP PROMPTS — code-defined templates: start with 2 (briefing, debrief).
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
// V1 CAP (docs/concepts/mcp-design.mdx): EXACTLY 2 prompts (briefing, debrief). Resources are
// deferred. {@link PROMPTS}.length is the auditable count; {@link MAX_PROMPTS}
// is the ceiling.
//
// ARG TYPING: MCP delivers prompt arguments as STRINGS over the wire, so every
// arg shape is string-valued — z.enum for the bounded selectors/modes, the SDK
// validates inbound args against the raw shape (mirrors registerTool).
//
// SCHEMA ALIGNMENT (hard rule 2 — constraints live in @3ngram/schema): the
// rendered text instructs the agent to call the briefing/remember TOOLS, so the
// prompt's argument vocabulary MUST be exactly what those tools accept. The flat,
// string-valued prompt args cannot be a Zod object, so instead of a hand-rolled
// local enum (which could DRIFT and tell the agent to call a tool with a value it
// rejects) we DERIVE the selector vocabulary from the canonical
// {@link briefingSelectorSchema} discriminator and validate the debrief `scope`
// against the canonical {@link scopeSchema} before rendering.
import { briefingModeSchema, briefingSelectorSchema, scopeSchema } from '@3ngram/schema'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

/**
 * A code-defined prompt, erased to a name + a server-bound registrar. The arg
 * shape is captured at the typed {@link definePrompt} call site, so the
 * heterogeneous {@link PROMPTS} registry stays name-typed without an `any`-typed
 * arg shape leaking across distinct prompts.
 */
interface RegisterablePrompt {
  name: string
  register: (server: McpServer) => void
}

/**
 * Define a code-defined prompt. `argsSchema` is a Zod RAW SHAPE (the SDK 1.x
 * `registerPrompt` contract: it wraps the shape in z.object internally and
 * validates the inbound, string-valued arguments against it — the same shape
 * convention as `registerTool`). `render` returns the bounded
 * {@link GetPromptResult}: a single user message whose text orients the agent;
 * it receives the SDK-VALIDATED, re-parsed args and reads NOTHING else (no DB,
 * no env). The returned registrar binds the prompt onto an McpServer;
 * registerPrompt auto-enables the `prompts` capability.
 */
function definePrompt<Args extends z.ZodRawShape>(prompt: {
  name: string
  config: { title: string; description: string; argsSchema: Args }
  render: (args: z.infer<z.ZodObject<Args>>) => GetPromptResult
}): RegisterablePrompt {
  // The SDK already validates inbound args against `argsSchema` before invoking
  // the callback; re-parsing through the same z.object is a zero-risk TYPE BRIDGE
  // that yields the exact `z.infer<z.ZodObject<Args>>` `render` declares (the
  // SDK's structurally-equal arg type does not generically unify with zod's).
  const argsObject = z.object(prompt.config.argsSchema)
  // Widen the config's argsSchema to the non-generic ZodRawShape so registerPrompt
  // infers a CONCRETE `Args` (mirrors how server.ts calls registerTool with the
  // wide tool config): a callback taking `unknown` is then assignable to the
  // resolved PromptCallback. A conditional PromptCallback over an UNRESOLVED
  // generic `Args` blocks assignability, so we must register non-generically.
  const config: { title: string; description: string; argsSchema: z.ZodRawShape } = prompt.config
  return {
    name: prompt.name,
    register: (server) =>
      server.registerPrompt(prompt.name, config, (args: unknown) =>
        prompt.render(argsObject.parse(args)),
      ),
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
    argsSchema: {
      selector: selectorArgSchema,
      mode: modeArgSchema.optional(),
    },
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
      'Close a session cleanly: review what happened, then persist what is worth keeping — decisions, commitments, and follow-ups — by calling the remember TOOL for each, and resolve any completed commitments.',
    argsSchema: {
      // VALIDATED against the canonical {@link scopeSchema} (kebab-case), the SAME
      // constraint the `remember` TOOL enforces — so a scope the prompt accepts is
      // a scope `remember` accepts, and the rendered "tag with scope X" line can
      // never instruct a value the tool would reject (e.g. "Work Notes").
      scope: scopeSchema
        .optional()
        .describe('Optional scope (kebab-case, e.g. work, personal) the session belonged to.'),
    },
  },
  render({ scope }) {
    const scopeLine =
      scope === undefined
        ? 'Tag each memory with the scope the work belonged to.'
        : `Tag each memory with scope "${scope}".`
    return userMessage(
      [
        'Debrief this session before closing. Review the conversation and extract what a',
        'future session needs, then PERSIST each item by calling the `remember` TOOL:',
        '',
        '- Decisions: architectural choices and resolved tradeoffs (memoryType "decision").',
        '- Commitments: things promised for later, with a due date if known (memoryType "commitment").',
        '- Follow-ups & notes: blockers and handoff state to continue from (memoryType "note").',
        '- Preferences & patterns: conventions or gotchas worth reusing.',
        '',
        scopeLine,
        '',
        'For any commitment COMPLETED this session, call the `resolve` TOOL on its memory id.',
        'Keep each memory atomic and self-contained; do not persist secrets or raw credentials.',
      ].join('\n'),
    )
  },
})

/**
 * THE code-defined prompt surface. Length === registered count; the v1 cap
 * (EXACTLY 2 — briefing, debrief; docs/concepts/mcp-design.mdx) is auditable from this one
 * array. Each entry carries its name (auditable) and a server-bound registrar,
 * so the registry stays type-safe over heterogeneous arg shapes without an `any`.
 */
export const PROMPTS: readonly RegisterablePrompt[] = [briefingPrompt, debriefPrompt]

/** Hard ceiling per docs/concepts/mcp-design.mdx (v1: exactly 2; resources deferred). */
export const MAX_PROMPTS = 2

/**
 * Register every code-defined prompt on the McpServer. Called from
 * {@link createMcpServer} alongside the registerTool loop; registerPrompt
 * auto-enables the `prompts` capability, so prompts/list + prompts/get are served
 * with no transport-route change. The render callback is synchronous and reads
 * only its validated args (no tenant context needed — a prompt carries no data).
 */
export function registerPrompts(server: McpServer): void {
  for (const prompt of PROMPTS) {
    prompt.register(server)
  }
}
