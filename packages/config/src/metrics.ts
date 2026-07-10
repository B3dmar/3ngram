// SPDX-License-Identifier: Apache-2.0
import {
  type Attributes,
  type Context,
  type Counter,
  type Histogram,
  type MetricOptions,
  metrics,
} from '@opentelemetry/api'

/**
 * Domain metrics counters (docs/concepts/observability.mdx §4). Vendor-neutral by
 * construction: call sites talk to @opentelemetry/api only. With no
 * MeterProvider registered (SENTRY_DSN unset — the self-host default) these
 * resolve to the API's built-in no-op meter, so every .add()/.record() is a
 * free no-op with zero call-site branching.
 *
 * Instruments are resolved lazily per global-provider identity, NOT at module
 * evaluation: @opentelemetry/api has no ProxyMeterProvider, so an instrument
 * created at import time would stay bound to the no-op meter even after
 * initObservability() installs a real provider (ESM evaluates all imports
 * before the entrypoint's first statement runs).
 */
const METER_NAME = '@3ngram/observability'

/**
 * Single namespace root for every domain metric name. All metric names derive
 * from this prefix via metricName() so the namespace can never drift one metric
 * at a time. Renaming the
 * namespace is dashboard-breaking — any external dashboard/alert must move in
 * lockstep.
 *
 * MUST start with an alphabetic character: the OpenTelemetry instrument-naming
 * spec requires names to begin with a letter, so a digit-leading prefix (e.g.
 * "3ngram") would make every instrument invalid/no-op once a real meter
 * provider is registered. Hence the spelled-out "threengram", not "3ngram".
 */
export const METRIC_PREFIX = 'threengram'

export const metricName = (suffix: string): string => `${METRIC_PREFIX}.${suffix}`

function perProvider<T>(create: () => T): () => T {
  let boundTo: unknown
  let instrument: T | undefined
  return () => {
    const provider = metrics.getMeterProvider()
    if (instrument === undefined || provider !== boundTo) {
      boundTo = provider
      instrument = create()
    }
    return instrument
  }
}

function lazyCounter(name: string, options: MetricOptions): Counter {
  const resolve = perProvider(() => metrics.getMeter(METER_NAME).createCounter(name, options))
  return {
    add(value: number, attributes?: Attributes, context?: Context): void {
      resolve().add(value, attributes, context)
    },
  }
}

function lazyHistogram(name: string, options: MetricOptions): Histogram {
  const resolve = perProvider(() => metrics.getMeter(METER_NAME).createHistogram(name, options))
  return {
    record(value: number, attributes?: Attributes, context?: Context): void {
      resolve().record(value, attributes, context)
    },
  }
}

export const memoryWritten = lazyCounter(metricName('memory.written'), {
  description: 'Memories written, by memory type',
})

export const memorySuperseded = lazyCounter(metricName('memory.superseded'), {
  description: 'Memories superseded (docs/concepts/memory-model.mdx append-and-supersede)',
})

export const searchLatencyMs = lazyHistogram(metricName('search.latency_ms'), {
  description: 'Unified search latency; p50/p95 derived from the distribution',
  unit: 'ms',
})

/** Consolidation accept-rate is the advisory consolidation model's early-warning signal (docs/concepts/memory-model.mdx). */
export const consolidationProposed = lazyCounter(metricName('consolidation.proposed'), {
  description: 'Consolidation proposals created',
})

export const consolidationAccepted = lazyCounter(metricName('consolidation.accepted'), {
  description: 'Consolidation proposals accepted',
})

export const consolidationRejected = lazyCounter(metricName('consolidation.rejected'), {
  description: 'Consolidation proposals rejected',
})

/** Per-tool labels (tool_name × client_ua) catch client version skew (§6). */
export const mcpToolCalls = lazyCounter(metricName('mcp.tool_calls'), {
  description: 'MCP tool invocations, by tool_name and client_ua',
})

export const mcpToolErrors = lazyCounter(metricName('mcp.tool_errors'), {
  description: 'MCP tool failures, by tool_name and reason_code',
})

/**
 * Rate-limit STORE failures (Redis unreachable), labelled by key_prefix (the
 * limiter/route class — no secrets, no principal ids). This is the alert signal
 * for a fail-open outage: when the store is down a fail-open limiter passes every
 * request, so brute-force protection silently vanishes with no
 * over-limit 429s to alert on — this counter is the ONLY metric that fires.
 */
export const rateLimitStoreFailure = lazyCounter(metricName('rate_limit.store_failure'), {
  description: 'Rate-limit store (Redis) failures, by key_prefix and fail_open posture',
})

/**
 * Budget-gate consumption-lookup failures. When the
 * usage-store lookup errors, the budget gate FAILS OPEN — it allows the metered
 * op rather than block all writes on a transient error — so there is no over-cap
 * rejection to alert on. This counter is the ONLY signal that cost protection
 * silently degraded; alert on it. Labelled by operation (no user id, no content).
 */
export const budgetGateLookupFailure = lazyCounter(metricName('budget.gate_lookup_failure'), {
  description: 'Budget-gate consumption-lookup failures (fail-open), by operation',
})

/**
 * Watch signal for the free→paid line.
 * Increments when a GENERATION-class LLM operation (the gateway.complete() surface
 * — entity extraction, digests, agents) is recorded — the moment real paid cost
 * begins. Today it never fires: no generation operation is registered and the
 * completion-accounting path is deferred, so all live traffic is embed-class.
 * When it first fires, the paid surface has become real and caps/enforcement must
 * be revisited. Content-free — labelled by operation only.
 */
export const generationCostObserved = lazyCounter(metricName('budget.generation_cost_observed'), {
  description:
    'Generation-class (paid) LLM usage recorded, by operation — the free→paid watch signal',
})
