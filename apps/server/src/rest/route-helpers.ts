// SPDX-License-Identifier: Apache-2.0
// Shared mechanics for thin REST route modules: exact-optional shaping,
// authenticated tenant access, temporal coercion, and uniform error mapping.
import { log } from '@3ngram/config'
import { crashSafeError } from '@3ngram/config/otel'
import type { AsOfInput, FactsRangeInput } from '@3ngram/schema'
import type { Request, Response } from 'express'
import { mapRestError } from './errors.js'

/** Drop undefined values so exact-optional core parameters remain absent. */
export function defined<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }
}

/** Map optional ISO coordinates to core Date values. */
export function toAsOf(
  asOf: AsOfInput | undefined,
): { validAt?: Date; asKnownAt?: Date } | undefined {
  if (asOf === undefined) return undefined
  return defined({
    validAt: asOf.validAt === undefined ? undefined : new Date(asOf.validAt),
    asKnownAt: asOf.asKnownAt === undefined ? undefined : new Date(asOf.asKnownAt),
  })
}

/** Map an optional {from,to} range's ISO bounds to core Date values (range read). */
export function toRange(
  range: FactsRangeInput | undefined,
): { from?: Date; to?: Date } | undefined {
  if (range === undefined) return undefined
  return defined({
    from: range.from === undefined ? undefined : new Date(range.from),
    to: range.to === undefined ? undefined : new Date(range.to),
  })
}

/** The authenticated tenant bound by apiOrSessionAuth. */
export function tenant(req: Request): string {
  return req.userId as string
}

/** Apply the shared typed-error mapping without logging request content. */
export async function guard(
  route: string,
  res: Response,
  handler: () => Promise<void>,
): Promise<void> {
  try {
    await handler()
  } catch (err) {
    const mapped = mapRestError(route, err)
    if (mapped !== undefined) {
      res.status(mapped.status).json(defined({ error: mapped.reason, detail: mapped.detail }))
      return
    }
    log().error({ route, ...crashSafeError(err) }, 'rest: handler failed')
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
  }
}
