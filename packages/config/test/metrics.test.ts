// SPDX-License-Identifier: Apache-2.0
import { metrics } from '@opentelemetry/api'
import { describe, expect, it } from 'vitest'
import {
  consolidationAccepted,
  consolidationProposed,
  consolidationRejected,
  METRIC_PREFIX,
  mcpHeaderRequests,
  mcpToolCalls,
  mcpToolErrors,
  memorySuperseded,
  memoryWritten,
  metricName,
  rateLimitStoreFailure,
  searchLatencyMs,
} from '../src/metrics.js'

describe('metric naming (OpenTelemetry instrument-name spec)', () => {
  // Every name covered by the domain-metrics surface; keep in sync with metrics.ts.
  const suffixes = [
    'memory.written',
    'memory.superseded',
    'search.latency_ms',
    'consolidation.proposed',
    'consolidation.accepted',
    'consolidation.rejected',
    'mcp.header_requests',
    'mcp.tool_calls',
    'mcp.tool_errors',
    'rate_limit.store_failure',
    'budget.gate_lookup_failure',
    'budget.generation_cost_observed',
  ]

  it('uses the alphabetic prefix "threengram" (a digit-leading prefix is invalid OTel)', () => {
    expect(METRIC_PREFIX).toBe('threengram')
  })

  it('every produced metric name starts with a letter (OTel requires it)', () => {
    for (const suffix of suffixes) {
      const name = metricName(suffix)
      expect(name, `${name} must start with an alphabetic character`).toMatch(/^[A-Za-z]/)
    }
  })
})

describe('domain metrics (docs/concepts/observability.mdx §4)', () => {
  it('counters no-op safely with no MeterProvider registered (self-host default)', () => {
    expect(() => {
      memoryWritten.add(1, { type: 'note' })
      memorySuperseded.add(1)
      consolidationProposed.add(1)
      consolidationAccepted.add(1)
      consolidationRejected.add(1)
      mcpHeaderRequests.add(1, {
        method: 'tools/call',
        name: 'remember',
        status: 'recognized',
      })
      mcpToolCalls.add(1, { tool_name: 'remember', client_ua: 'claude' })
      mcpToolErrors.add(1, { tool_name: 'remember', reason_code: 'validation' })
      rateLimitStoreFailure.add(1, { key_prefix: 'auth:ip', fail_open: true })
    }).not.toThrow()
  })

  it('latency histogram records without a provider', () => {
    expect(() => searchLatencyMs.record(42, { operation: 'search' })).not.toThrow()
  })

  it('rebinds to a provider installed AFTER first use (api has no ProxyMeterProvider)', () => {
    memoryWritten.add(1) // first use binds to the no-op meter
    const added: unknown[] = []
    const fakeProvider = {
      getMeter: () => ({
        createCounter: () => ({
          add: (value: number, attributes?: Record<string, unknown>) => {
            added.push([value, attributes])
          },
        }),
      }),
    }
    metrics.setGlobalMeterProvider(fakeProvider as never)
    try {
      memoryWritten.add(2, { type: 'note' })
      expect(added).toEqual([[2, { type: 'note' }]])
    } finally {
      metrics.disable()
    }
  })
})
