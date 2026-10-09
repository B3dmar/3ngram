// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs'
import type { Envelope } from '../hooks/lib/contract.ts'
import { parseEnvelope } from '../hooks/lib/contract.ts'

// The golden envelopes the Go side writes (cmd/3ngram-hook/testdata/commitments),
// so a contract change fails here as well as there.
const GOLDEN = new URL('../../../cmd/3ngram-hook/testdata/commitments/', import.meta.url)

export function goldenText(name: string): string {
  return readFileSync(new URL(name, GOLDEN), 'utf8')
}

export function golden(name: string): Envelope {
  const parsed = parseEnvelope(goldenText(name))
  if (!parsed.ok) throw new Error(`golden ${name} did not parse: ${parsed.reason}`)
  return parsed.envelope
}

// withFingerprint is a golden envelope as read under another context.
export function withFingerprint(envelope: Envelope, fingerprint: string): Envelope {
  return { ...envelope, context: { ...envelope.context, fingerprint } }
}

export const FP_A = 'aaaaaaaaaaaaaaaa'
export const FP_B = 'bbbbbbbbbbbbbbbb'
