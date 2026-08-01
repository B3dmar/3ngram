// SPDX-License-Identifier: Apache-2.0
// Typed insert helper for the audit_log table.
//
// audit_log is a SYSTEM table (ops.ts comment: 'audit_log gets INSERT-only
// grants'; provision-roles.sql: `GRANT SELECT, INSERT ON memory_events,
// audit_log`). Its user_id is NULLABLE — pre-auth OAuth events carry no
// tenant. Access goes through getAdminDb() NOT withTenant(), mirroring the
// auth-admin / auth-oauth-clients discipline: the tenant_isolation policy on
// audit_log (schema/ops.ts) grants tenant-less sessions full access and pins
// tenant-bound transactions to their own rows (defense in depth).
// getAdminDb stays internal to this package; the public barrel exports only
// this narrow typed helper.
//
// SECRET DISCIPLINE (hard rule 6): the metadata field MUST NOT include raw
// tokens, secrets, codes, or query content — only sanitised fields such as
// client_id, action name, and result kind. Callers bear this responsibility;
// this module trusts the passed entry.

import type { ActorKind } from '@3ngram/schema'
import { and, eq } from 'drizzle-orm'
import { getAdminDb } from './client.js'
import { auditLog } from './schema/ops.js'

export interface AuditLogEntry {
  userId?: string
  actorKind: ActorKind
  action: string
  resource?: string
  ip?: string
  metadata?: Record<string, unknown>
}

/**
 * Insert one row into the audit_log system table. Fire-and-forget safe: the
 * promise resolves when the insert commits and rejects on DB error. Callers
 * MUST catch and log the rejection rather than letting it propagate — use the
 * pattern in api-key.ts (touchApiKeyLastUsed) for fire-and-forget wiring.
 *
 * Never pass raw tokens, secrets, codes, or query content in `metadata`.
 */
export async function insertAuditLog(entry: AuditLogEntry): Promise<void> {
  await getAdminDb().insert(auditLog).values({
    userId: entry.userId,
    actorKind: entry.actorKind,
    action: entry.action,
    resource: entry.resource,
    ip: entry.ip,
    metadata: entry.metadata,
  })
}

/**
 * True when at least one audit_log row already exists for this user + action.
 * Used to make a once-only side-effect (e.g. the account-deletion tombstone)
 * idempotent under retry: a prior run that committed its DB work but failed
 * before/at the audit insert can be completed without writing a duplicate.
 * Reads via getAdminDb() (tenant-less, which the audit_log tenant_isolation
 * policy permits), mirroring insertAuditLog.
 */
export async function auditLogEntryExists(userId: string, action: string): Promise<boolean> {
  const rows = await getAdminDb()
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), eq(auditLog.action, action)))
    .limit(1)
  return rows.length > 0
}
