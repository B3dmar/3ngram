// SPDX-License-Identifier: Apache-2.0
// In-memory stand-in for the slice of the ioredis client that the OAuth
// exchange-failure tracker (src/routes/oauth-token.ts) uses: GET, DEL, INCR,
// EXPIRE, TTL and MULTI/EXEC. It replaces ioredis-mock, whose Lua engine
// (fengari) pulled in sprintf-js (GHSA-hp3w-g68c-fv3c, no patched release).
//
// The commands follow Redis semantics, not a convenience approximation:
// - INCR treats a missing key as 0, rejects a non-integer value with Redis's
//   error, and keeps the key's TTL.
// - EXPIRE sets a deadline on an existing key (1) and is a no-op on a missing
//   key (0); a non-positive timeout deletes the key.
// - TTL is -2 for a missing key, -1 for a key with no deadline, otherwise the
//   remaining seconds rounded as Redis does ((ms + 500) / 1000).
// - Expiry is lazy against Date.now() (a key dies once now > deadline), so
//   vi.useFakeTimers() drives it.
// - MULTI queues commands; EXEC runs them back to back with nothing in between
//   and resolves [err, reply] tuples. A failing command does not stop the rest.
// - duplicate() returns another client on the same keyspace, the way a second
//   replica connects to the same Redis.

type Entry = { value: string; expiresAt?: number }
type Reply = number | string | null
type ExecResult = Array<[Error | null, Reply]>

export class FakeRedis {
  readonly #keyspace: Map<string, Entry>

  constructor(keyspace: Map<string, Entry> = new Map()) {
    this.#keyspace = keyspace
  }

  duplicate(): FakeRedis {
    return new FakeRedis(this.#keyspace)
  }

  async get(key: string): Promise<string | null> {
    return this.#live(key)?.value ?? null
  }

  async del(...keys: string[]): Promise<number> {
    return keys.filter((key) => this.#live(key) !== undefined && this.#keyspace.delete(key)).length
  }

  async incr(key: string): Promise<number> {
    return this.#incr(key)
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.#expire(key, seconds)
  }

  async ttl(key: string): Promise<number> {
    const entry = this.#live(key)
    if (entry === undefined) return -2
    if (entry.expiresAt === undefined) return -1
    return Math.floor((Math.max(entry.expiresAt - Date.now(), 0) + 500) / 1000)
  }

  multi() {
    const queue: Array<() => Reply> = []
    const transaction = {
      incr: (key: string) => {
        queue.push(() => this.#incr(key))
        return transaction
      },
      expire: (key: string, seconds: number) => {
        queue.push(() => this.#expire(key, seconds))
        return transaction
      },
      exec: async (): Promise<ExecResult> =>
        queue.map((command): [Error | null, Reply] => {
          try {
            return [null, command()]
          } catch (err: unknown) {
            return [err instanceof Error ? err : new Error(String(err)), null]
          }
        }),
    }
    return transaction
  }

  #live(key: string): Entry | undefined {
    const entry = this.#keyspace.get(key)
    if (entry?.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.#keyspace.delete(key)
      return undefined
    }
    return entry
  }

  #incr(key: string): number {
    const entry = this.#live(key)
    const current = entry?.value ?? '0'
    if (!/^-?\d+$/.test(current)) throw new Error('ERR value is not an integer or out of range')
    const next = Number(current) + 1
    if (entry === undefined) this.#keyspace.set(key, { value: String(next) })
    else entry.value = String(next)
    return next
  }

  #expire(key: string, seconds: number): number {
    const entry = this.#live(key)
    if (entry === undefined) return 0
    if (seconds <= 0) this.#keyspace.delete(key)
    else entry.expiresAt = Date.now() + seconds * 1000
    return 1
  }
}
