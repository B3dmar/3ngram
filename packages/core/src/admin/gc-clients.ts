// SPDX-License-Identifier: Apache-2.0
// Registered-but-never-used OAuth client GC (30-day idle policy). This
// is the BUSINESS LOGIC the apps/worker BullMQ harness
// invokes — the harness only schedules/invokes/shuts down (hard rule 5);
// everything below is core. Mirrors admin/consolidate.ts: a clock-injected,
// repo-seamed policy unit-tested with no database.
//
// WHAT IT REMOVES (narrow by design): clients with last_used_at IS NULL whose
// created_at is older than GC_CLIENT_IDLE_DAYS. last_used_at is stamped on the
// FIRST successful token exchange (oauth-token route, fire-and-forget), so a
// NULL means "registered, never exchanged a token" — exactly RFC 7591's
// registered-but-never-used class. A client that ever issued a token (NULL
// cleared) is NEVER collected here, so no live grant is ever orphaned. This is
// not a memory write path (hard rule 1 governs memory rows, not transient
// pre-auth DCR registrations).
//
// Observability (hard rule 6): ids/counts only — the result carries counts; the
// worker logs them. No client_id, secret, or token material is returned or logged.
import { deleteClients, listGarbageCollectableClients } from '@3ngram/db'

/**
 * Idle threshold (days) before a registered-but-never-used client is GC'd
 * ("registered-but-never-used clients GC'd after 30 days").
 * A policy constant, not a magic number — the cutoff is `now - this`.
 */
export const GC_CLIENT_IDLE_DAYS = 30

const MS_PER_DAY = 86_400_000

/**
 * The data seam the GC needs, injectable so the policy is unit-tested against a
 * fake repo with NO database (the worker test stubs this). The default
 * implementation ({@link dbGcClientsRepo}) wraps the @3ngram/db helpers — both
 * touch the global oauth_clients system table via the audited admin path (no
 * tenant context: a pre-auth DCR registration has no user_id).
 */
export interface GcClientsRepo {
  /** client_ids of registrations with last_used_at IS NULL and created_at < cutoff. */
  listGarbageCollectableClients(cutoff: Date): Promise<string[]>
  /** Hard-delete the named never-used clients; returns the deleted count. */
  deleteClients(clientIds: string[]): Promise<number>
}

/** Tunables for one GC run. */
export interface GcClientsOptions {
  /** Override the idle threshold in days (default {@link GC_CLIENT_IDLE_DAYS}). */
  idleDays?: number
  /** Injected clock for the cutoff (no clock in core — testability/hard-rule hygiene). */
  now?: Date
}

/** Per-run outcome, content-free — safe to log. */
export interface GcClientsResult {
  /** Clients that matched the idle predicate this run. */
  candidates: number
  /** Clients actually deleted (== candidates barring a concurrent race). */
  collected: number
}

/**
 * Run one GC pass: delete every registered-but-never-used client older than the
 * idle threshold. The cutoff is `now - idleDays`; the repo's predicate
 * (last_used_at IS NULL AND created_at < cutoff) is the only deletion gate, so a
 * client that ever issued a token is structurally exempt. Returns content-free
 * counts. A repo failure propagates so BullMQ marks the job failed and retries
 * (the harness owns retry policy) rather than reporting a falsely-green run.
 */
export async function garbageCollectClients(
  repo: GcClientsRepo,
  options: GcClientsOptions = {},
): Promise<GcClientsResult> {
  const idleDays = options.idleDays ?? GC_CLIENT_IDLE_DAYS
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - idleDays * MS_PER_DAY)
  const candidates = await repo.listGarbageCollectableClients(cutoff)
  if (candidates.length === 0) return { candidates: 0, collected: 0 }
  const collected = await repo.deleteClients(candidates)
  return { candidates: candidates.length, collected }
}

// The db helpers already use the audited admin path (oauth_clients is the global
// system table with no user_id), so there is no withTenant() wrapper here — the
// pre-auth DCR registration has no tenant. This mirrors consolidate's
// listTenantIds, the one pre-tenant read.

/** The production {@link GcClientsRepo}: the @3ngram/db admin-path helpers. */
export const dbGcClientsRepo: GcClientsRepo = {
  listGarbageCollectableClients,
  deleteClients,
}
