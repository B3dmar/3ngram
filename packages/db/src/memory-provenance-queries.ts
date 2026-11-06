// SPDX-License-Identifier: Apache-2.0
import {
  MAX_PROVENANCE_EVENTS,
  MAX_PROVENANCE_FACTS,
  MAX_PROVENANCE_PRODUCTS,
  MAX_PROVENANCE_PROPOSALS,
} from '@3ngram/schema'
import { sql } from 'drizzle-orm'

/** Parse untrusted stored JSON without throwing, retaining canonical UUID spelling only.
 * The indexed column remains UUID-typed, so joins use (user_id, id), not a tenant scan. */
export function eventUuid(key: 'sessionRunId' | 'proposalId') {
  const raw = sql`e.payload->>${key}`
  return sql`CASE WHEN pg_input_is_valid(${raw}, 'uuid') THEN
    CASE WHEN lower(${raw}) = (${raw})::uuid::text THEN (${raw})::uuid END END`
}

/** A JSON reference resolves only against the caller's proposal table. */
export function eventProducer(userId: string) {
  return sql`CASE WHEN e.actor_kind <> 'importer' THEN (
    SELECT jsonb_build_object('proposalKind', p.kind, 'proposalId', p.id)
    FROM (
      SELECT id, 'edge' AS kind FROM consolidation_proposals WHERE user_id = ${userId}::uuid
      UNION ALL SELECT id, 'fact' FROM fact_proposals WHERE user_id = ${userId}::uuid
      UNION ALL SELECT id, 'resolution' FROM resolution_proposals WHERE user_id = ${userId}::uuid
      UNION ALL SELECT id, 'retention' FROM retention_proposals WHERE user_id = ${userId}::uuid
    ) p WHERE p.id = ${eventUuid('proposalId')} AND p.kind = e.payload->>'proposalKind'
  ) END`
}

export function originQuery(userId: string) {
  return sql`SELECT jsonb_build_object(
    'actorKind', e.actor_kind, 'createdAt', e.created_at,
    'sessionRunId', s.id,
    'run', CASE WHEN s.id IS NOT NULL THEN jsonb_build_object('agent', s.agent, 'openedAt', s.opened_at) END
  ) AS value FROM memory_events e
  LEFT JOIN agent_sessions s ON s.user_id = ${userId}::uuid
    AND s.id = ${eventUuid('sessionRunId')} AND e.actor_kind <> 'importer'
  WHERE e.user_id = ${userId}::uuid AND e.memory_id = root.id
    AND ((e.event_kind = 'create' AND e.actor_kind <> 'importer')
      OR (e.event_kind = 'import' AND e.actor_kind = 'importer'))
  ORDER BY e.created_at, e.id LIMIT 1`
}

export function eventsQuery(userId: string) {
  return sql`SELECT jsonb_build_object(
    'id', e.id, 'eventKind', e.event_kind, 'actorKind', e.actor_kind,
    'createdAt', e.created_at, 'sessionRunId', s.id, 'sourceProposal', ${eventProducer(userId)}
  ) AS value FROM memory_events e
  LEFT JOIN agent_sessions s ON s.user_id = ${userId}::uuid
    AND s.id = ${eventUuid('sessionRunId')} AND e.actor_kind <> 'importer'
  WHERE e.user_id = ${userId}::uuid AND e.memory_id = root.id
  ORDER BY e.created_at DESC, e.id DESC LIMIT ${MAX_PROVENANCE_EVENTS + 1}`
}

export function factsQuery(userId: string) {
  return sql`SELECT jsonb_build_object('id', f.id, 'validFrom', f.valid_from,
    'validTo', f.valid_to, 'sourceProposalId', p.id) AS value
  FROM facts f LEFT JOIN fact_proposals p
    ON p.user_id = ${userId}::uuid AND p.id = f.source_fact_proposal_id
  WHERE f.user_id = ${userId}::uuid AND f.memory_id = root.id
  ORDER BY f.created_at DESC, f.id DESC LIMIT ${MAX_PROVENANCE_FACTS + 1}`
}

export function proposalsQuery(userId: string) {
  return sql`SELECT p.* FROM (
    SELECT id, 'edge' AS kind, edge_type, NULL::text AS action,
      CASE WHEN from_id = root.id THEN to_id ELSE from_id END AS other_memory_id, created_at, decided_at
    FROM consolidation_proposals WHERE user_id = ${userId}::uuid AND status = 'applied'
      AND (from_id = root.id OR to_id = root.id)
    UNION ALL SELECT id, 'fact', NULL, NULL, NULL, created_at, decided_at
    FROM fact_proposals WHERE user_id = ${userId}::uuid AND status = 'applied' AND memory_id = root.id
    UNION ALL SELECT id, 'resolution', NULL, NULL, NULL, created_at, decided_at
    FROM resolution_proposals WHERE user_id = ${userId}::uuid AND status = 'applied' AND memory_id = root.id
    UNION ALL SELECT id, 'retention', NULL, action,
      CASE WHEN memory_id = root.id THEN related_memory_id ELSE memory_id END, created_at, decided_at
    FROM retention_proposals WHERE user_id = ${userId}::uuid AND status = 'applied'
      AND (memory_id = root.id OR related_memory_id = root.id)
  ) p ORDER BY created_at DESC, id DESC LIMIT ${MAX_PROVENANCE_PROPOSALS + 1}`
}

export function proposalProductsQuery(userId: string) {
  return sql`SELECT jsonb_build_object(
    'id', p.id, 'kind', p.kind, 'edgeType', p.edge_type, 'action', p.action,
    'otherMemoryId', p.other_memory_id, 'createdAt', p.created_at, 'decidedAt', p.decided_at,
    'produced', jsonb_build_object('edgeIds', edges.ids, 'factIds', facts.ids, 'eventIds', events.ids)
  ) AS value FROM (${proposalsQuery(userId)}) p
  CROSS JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(id), '[]') AS ids FROM (
      SELECT id FROM memory_edges WHERE user_id = ${userId}::uuid
        AND ((p.kind = 'edge' AND source_consolidation_proposal_id = p.id)
          OR (p.kind = 'retention' AND source_retention_proposal_id = p.id))
      ORDER BY created_at, id LIMIT ${MAX_PROVENANCE_PRODUCTS + 1}
    ) bounded
  ) edges
  CROSS JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(id), '[]') AS ids FROM (
      SELECT id FROM facts WHERE user_id = ${userId}::uuid
        AND p.kind = 'fact' AND source_fact_proposal_id = p.id
      ORDER BY created_at, id LIMIT ${MAX_PROVENANCE_PRODUCTS + 1}
    ) bounded
  ) facts
  CROSS JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(id), '[]') AS ids FROM (
      SELECT id FROM memory_events WHERE user_id = ${userId}::uuid AND actor_kind <> 'importer'
        AND lower(payload->>'proposalId') = p.id::text AND payload->>'proposalKind' = p.kind
      ORDER BY created_at, id LIMIT ${MAX_PROVENANCE_PRODUCTS + 1}
    ) bounded
  ) events ORDER BY p.created_at DESC, p.id DESC`
}
