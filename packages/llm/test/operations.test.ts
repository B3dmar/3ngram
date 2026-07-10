// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  assertMeteredOperationsRegistered,
  capabilityClassForOperation,
  LlmOperationNotRegisteredError,
  llmOperations,
  METERED_EMBED_OPERATIONS,
  maxCostUsdForOperation,
  maxRegisteredCostUsd,
} from '../src/operations.js'

describe('operation registry', () => {
  it('registers every metered embed operation (boot drift guard)', () => {
    for (const operation of METERED_EMBED_OPERATIONS) {
      expect(llmOperations[operation], `missing registry entry for ${operation}`).toBeDefined()
    }
  })

  it('assertMeteredOperationsRegistered() passes for the shipped registry', () => {
    expect(() => assertMeteredOperationsRegistered()).not.toThrow()
  })

  it('maxCostUsdForOperation returns a positive ceiling for a registered op', () => {
    const cost = maxCostUsdForOperation('memory.embed')
    expect(cost).toBeGreaterThan(0)
    expect(cost).toBe(llmOperations['memory.embed']?.maxCostUsd)
  })

  it('maxCostUsdForOperation throws a named error for an unregistered op', () => {
    let thrown: unknown
    try {
      maxCostUsdForOperation('does.not.exist')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LlmOperationNotRegisteredError)
    expect((thrown as LlmOperationNotRegisteredError).operation).toBe('does.not.exist')
    // Message names the operation but carries no content (it is an op key only).
    expect((thrown as Error).message).toContain('does.not.exist')
  })

  it('maxRegisteredCostUsd is the max ceiling across all operations', () => {
    const max = maxRegisteredCostUsd()
    const expected = Math.max(...Object.values(llmOperations).map((op) => op.maxCostUsd))
    expect(max).toBe(expected)
    for (const op of Object.values(llmOperations)) {
      expect(max).toBeGreaterThanOrEqual(op.maxCostUsd)
    }
  })
})

describe('operation capability class (spec 010 FR-001/FR-004)', () => {
  it('every registered operation declares a valid capability class', () => {
    for (const [operation, entry] of Object.entries(llmOperations)) {
      expect(['embed', 'generation'], `invalid capabilityClass for ${operation}`).toContain(
        entry.capabilityClass,
      )
    }
  })

  it('every metered embed operation is embed-class (Free surface)', () => {
    for (const operation of METERED_EMBED_OPERATIONS) {
      expect(capabilityClassForOperation(operation), `${operation} should be embed-class`).toBe(
        'embed',
      )
    }
  })

  it('capabilityClassForOperation throws a named error for an unregistered op', () => {
    let thrown: unknown
    try {
      capabilityClassForOperation('reasoning.generate')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LlmOperationNotRegisteredError)
    expect((thrown as LlmOperationNotRegisteredError).operation).toBe('reasoning.generate')
  })

  it('the boot assertion still passes with the class check', () => {
    expect(() => assertMeteredOperationsRegistered()).not.toThrow()
  })
})
