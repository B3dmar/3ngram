// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import { runWithContext } from '@3ngram/config'
import type { NextFunction, Request, Response } from 'express'

/**
 * Enter the AsyncLocalStorage request scope at the transport boundary
 * (docs/concepts/observability.mdx §1): every log line downstream carries request_id and
 * surface via log(). The id is echoed as x-request-id for client correlation.
 */
export function requestContext(_req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID()
  res.setHeader('x-request-id', requestId)
  runWithContext({ requestId, surface: 'rest' }, next)
}
