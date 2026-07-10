// SPDX-License-Identifier: Apache-2.0

import type { ResourceLimitKind } from '@3ngram/schema'

/** A transactional write or token issuance exhausted a resource dimension. */
export class ResourceLimitExceededError extends Error {
  constructor(public readonly resource: ResourceLimitKind) {
    super(`resource limit reached: ${resource}`)
    this.name = 'ResourceLimitExceededError'
  }
}
