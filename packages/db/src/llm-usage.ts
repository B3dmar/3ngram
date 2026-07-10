// SPDX-License-Identifier: Apache-2.0
// llm_usage cost-tracking writes.
//
// The CLIENT MODULE (packages/core) tracks cost; the gateway stays
// thin. After a gateway.embed() round-trip, core computes cost_usd from the
// surfaced token usage and lands EXACTLY ONE usage row per call via this narrow
// helper — never per text, never with content.
//
// llm_usage is USER-OWNED (RLS, tenantPolicy at schema/ops.ts) — unlike the
// system audit_log table. So this write goes through withTenant() (hard rule 3),
// exactly like updateMemoryEmbedding: the runtime role app_user has INSERT on
// llm_usage (provision-roles.sql) and the row is scoped to the tenant. Raw pool
// / getAdminDb access is BANNED here (that is the wrong model for an RLS table).
//
// Observability (hard rule 6): a usage row carries operation / model / token
// counts / cost ONLY — NEVER the embedded text, the vector, or any content.
import { withTenant } from './client.js'
import { llmUsage } from './schema/ops.js'

/**
 * One cost-tracking row to persist. Already validated/computed by the caller
 * (hard rule 2: packages/db does not re-validate). `costUsd` is a decimal string
 * or number the numeric(20,12) column accepts; `outputTokens` is 0 for embeddings
 * (structural — the vector is not billed as generation).
 */
export interface LlmUsageWrite {
  /** Operation key for cost attribution, e.g. 'memory.embed' / 'import.embed'. */
  operation: string
  /** Model that produced the result (cost-rate provenance). */
  model: string
  /** Prompt/input tokens billed for the call. */
  inputTokens: number
  /** Generated tokens — 0 for embeddings. */
  outputTokens: number
  /** Computed cost in USD; null when no rate is known for the model. */
  costUsd: number | null
}

/**
 * Persist a single `llm_usage` row for `userId`, scoped by RLS (withTenant).
 *
 * Records cost/token accounting for one gateway call. NEVER records content
 * (hard rule 6) — the typed input carries no text. Best-effort by the caller:
 * cost tracking must never break the user-facing operation, so callers guard
 * this with a catch on the background path.
 */
export async function insertLlmUsage(userId: string, usage: LlmUsageWrite): Promise<void> {
  await withTenant(userId, (tx) =>
    tx.insert(llmUsage).values({
      userId,
      operation: usage.operation,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      // numeric column: drizzle expects a string; null leaves cost unknown.
      // scale 12 (picodollar) preserves sub-microdollar embedding costs — at
      // scale 6 a small-model embed (2e-8/token) rounded to 0.000000.
      costUsd: usage.costUsd === null ? null : usage.costUsd.toFixed(12),
    }),
  )
}
