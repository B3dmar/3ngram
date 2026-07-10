// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commitmentFsmTriggerSql } from '../src/fsm-trigger.js'

describe('commitment FSM trigger migration', () => {
  it('matches the generator exactly — COMMITMENT_TRANSITIONS cannot drift from the DB', () => {
    const migration = readFileSync(
      join(import.meta.dirname, '../migrations/0001_commitment_fsm_trigger.sql'),
      'utf8',
    )
    expect(migration).toBe(commitmentFsmTriggerSql())
  })
})
