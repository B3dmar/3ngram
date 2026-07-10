// SPDX-License-Identifier: Apache-2.0
// Output-validation error surface — shared by BOTH transports'
// error ladders (mcp/errors.ts, rest/errors.ts), so a result that fails its
// OUTPUT schema is labeled honestly as a SERVER-side shape fault and never
// mislabeled `invalid_input` (which blames the caller for a bug on our side).
//
// Observability (hard rule 6): the wrapped ZodError's issues may reference
// result VALUES, so this error keeps only content-free coordinates — the
// surface name, the issue count, and the issue PATHS (schema field names +
// array indices, never memory content). The original ZodError is deliberately
// NOT retained as `cause` so no content can leak through a serialized error.
import type { ZodError, ZodType, z } from 'zod'

/** A tool/route RESULT failed its output schema — a server fault, not bad input. */
export class OutputValidationError extends Error {
  /** The tool/route whose result failed validation. */
  readonly surface: string
  /** Number of schema issues (bounded metadata only). */
  readonly issueCount: number
  /** Issue paths — schema field names and array indices, never values. */
  readonly issuePaths: string[]

  constructor(surface: string, zodError: ZodError) {
    super(`${surface} produced a result that failed output validation`)
    this.name = 'OutputValidationError'
    this.surface = surface
    this.issueCount = zodError.issues.length
    this.issuePaths = zodError.issues.map((issue) => issue.path.join('.'))
  }
}

/**
 * Parse a handler's RESULT against its output schema, rethrowing a ZodError as
 * {@link OutputValidationError} so the transport error ladder can distinguish a
 * server-side result-shape fault from malformed caller input. Input `.parse()`
 * calls stay bare — only OUTPUT parses go through here.
 */
export function parseOutput<S extends ZodType>(
  surface: string,
  schema: S,
  value: unknown,
): z.infer<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new OutputValidationError(surface, result.error)
  }
  return result.data as z.infer<S>
}
