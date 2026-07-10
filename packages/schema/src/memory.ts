// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod'

/**
 * Memory types (docs/concepts/data-model.mdx).
 * `event` is episodic and gets special consolidation treatment — see
 * CONSOLIDATION_POLICIES in ./consolidation.ts.
 */
export const memoryTypeSchema = z.enum([
  'decision',
  'commitment',
  'blocker',
  'fact',
  'preference',
  'pattern',
  'note',
  'event',
])
export type MemoryType = z.infer<typeof memoryTypeSchema>
export const MEMORY_TYPES = memoryTypeSchema.options

/**
 * Memory row status. Supersession is NOT a status — it is expressed by
 * bi-temporal columns (valid_to) plus a `supersedes` edge (docs/concepts/memory-model.mdx).
 */
export const memoryStatusSchema = z.enum(['active', 'archived'])
export type MemoryStatus = z.infer<typeof memoryStatusSchema>

/**
 * Typed relationships between memories (docs/concepts/memory-model.mdx "Append-and-supersede").
 * The write path appends; meaning lives on edges, never in destructive merges.
 */
export const edgeTypeSchema = z.enum(['supersedes', 'updates', 'extends', 'derives'])
export type EdgeType = z.infer<typeof edgeTypeSchema>
export const EDGE_TYPES = edgeTypeSchema.options

/**
 * Append-only lifecycle audit events (memory_events table).
 *
 * `embed_failed` records that the ack-before-embed background task
 * could not produce/persist an embedding for a memory — the write
 * itself already succeeded (the caller was ACKed), so this is a derived-metadata
 * failure note, never a content event. It exists because embedding is best-effort
 * and must never throw into the caller; the audit row is the durable signal a
 * backfill job keys on (no embed-specific kind existed, so we add one rather than
 * overload `revise`/`archive`).
 */
export const eventKindSchema = z.enum([
  'create',
  'revise',
  'supersede',
  'resolve',
  'unresolve',
  'archive',
  'import',
  'embed_failed',
])
export type EventKind = z.infer<typeof eventKindSchema>

/** Who acted — every lifecycle event records its actor class. */
export const actorKindSchema = z.enum([
  'user_dashboard',
  'user_api',
  'user_mcp',
  'worker',
  'importer',
  'system',
])
export type ActorKind = z.infer<typeof actorKindSchema>
