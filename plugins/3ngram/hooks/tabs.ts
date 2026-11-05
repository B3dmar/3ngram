// SPDX-License-Identifier: Apache-2.0

import type { EngineInterface } from 'claude-code'
import { atom, read, update } from 'claude-code'

export type Tab = 'commitments' | 'session'
const tab = atom({ plugin: '3ngram', key: 'tab' } as const, 'commitments' as Tab)

export async function readTab($: EngineInterface): Promise<Tab> {
  return (await read($, tab)) === 'session' ? 'session' : 'commitments'
}

export async function selectTab($: EngineInterface, selected: Tab): Promise<void> {
  await update($, tab, () => selected)
}
