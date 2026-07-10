// SPDX-License-Identifier: Apache-2.0
// @3ngram/sdk — published typed client over the REST /api/v1 surface
// (docs/concepts/architecture.mdx: one core, N transports).
export {
  type FetchLike,
  type SearchOptions,
  ThreengramClient,
  type ThreengramClientConfig,
} from './client.js'
export { ThreengramApiError, ThreengramNetworkError } from './errors.js'
