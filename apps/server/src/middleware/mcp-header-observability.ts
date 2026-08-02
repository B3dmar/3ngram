// SPDX-License-Identifier: Apache-2.0
// Pre-parser MCP routing observability for SEP-2243 standard headers.
//
// Mcp-Method and Mcp-Name are UNTRUSTED hints here. Values are reduced to
// closed allowlists before entering metrics or log context. The SDK later
// cross-checks the headers against the parsed body, and tool authorization
// remains inside the verified per-request handler.
import { bindContext, mcpHeaderRequests } from '@3ngram/config'
import type { NextFunction, Request, Response } from 'express'
import { PROMPTS } from '../mcp/prompts.js'
import { TOOLS } from '../mcp/tools.js'

const KNOWN_METHODS = new Set([
  'server/discover',
  'initialize',
  'ping',
  'tools/list',
  'tools/call',
  'prompts/list',
  'prompts/get',
])
const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name))
const PROMPT_NAMES = new Set(PROMPTS.map((prompt) => prompt.name))

type HeaderStatus =
  | 'missing_method'
  | 'unknown_method'
  | 'missing_name'
  | 'unknown_name'
  | 'recognized'

export interface McpHeaderObservation {
  method: string
  name: string
  status: HeaderStatus
}

/**
 * Collapse attacker-controlled headers into bounded metric labels. The literal
 * raw values never leave this function.
 */
export function classifyMcpHeaders(
  methodHeader: string | undefined,
  nameHeader: string | undefined,
): McpHeaderObservation {
  if (methodHeader === undefined) {
    return { method: 'missing', name: 'none', status: 'missing_method' }
  }
  if (!KNOWN_METHODS.has(methodHeader)) {
    return { method: 'unknown', name: 'none', status: 'unknown_method' }
  }

  const names =
    methodHeader === 'tools/call'
      ? TOOL_NAMES
      : methodHeader === 'prompts/get'
        ? PROMPT_NAMES
        : undefined
  if (names === undefined) {
    return { method: methodHeader, name: 'none', status: 'recognized' }
  }
  if (nameHeader === undefined) {
    return { method: methodHeader, name: 'missing', status: 'missing_name' }
  }
  if (!names.has(nameHeader)) {
    return { method: methodHeader, name: 'unknown', status: 'unknown_name' }
  }
  return { method: methodHeader, name: nameHeader, status: 'recognized' }
}

/**
 * Observe MCP headers before express.json(). The downstream SDK remains the
 * only header/body validator; this middleware never accepts, rejects, meters,
 * rate-limits, or authorizes a request.
 */
export function mcpHeaderObservability(req: Request, _res: Response, next: NextFunction): void {
  const observation = classifyMcpHeaders(req.header('mcp-method'), req.header('mcp-name'))
  mcpHeaderRequests.add(1, {
    method: observation.method,
    name: observation.name,
    status: observation.status,
  })

  const operation =
    observation.method === 'missing' || observation.method === 'unknown'
      ? undefined
      : observation.method
  bindContext({
    surface: 'mcp',
    ...(operation === undefined ? {} : { operation }),
    ...(observation.method === 'tools/call' && observation.status === 'recognized'
      ? { toolName: observation.name }
      : {}),
  })
  next()
}
