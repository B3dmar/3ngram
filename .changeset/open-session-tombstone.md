---
'@3ngram/db': patch
'@3ngram/core': patch
'@3ngram/server': patch
---

Refuse an agent-session open on an account that was erased while the request was in flight.

`openSession` took only `lockSessionAttach` and never consulted the account-deletion tombstone, so an authenticated `/open` that blocked past the erasure's bulk redaction could still INSERT a new `agent_sessions` row — selector and `briefed_memories` and all — or restamp the briefing fields on reopen. Both land user content after the write that is documented as the FINAL content write for the account (`packages/db/src/account-delete.ts`).

It now takes the account-lifecycle advisory lock in SHARED mode and re-checks the tombstone under it as its first statement, throwing `AccountDeletedError`, which REST maps to `410 account_deleted`. Shared mode is the point: a session open must serialize against erasure, never against other session opens. Unlike the heartbeat's excerpt guard, which drops the excerpt and lets the structural lease refresh through, an open is refused outright — there is nothing left worth writing once its content is dropped.

The heartbeat's own acquisition is hoisted above `lockSessionAttach` on the resurrect path, and only when the hook carries an excerpt. Requesting the two locks in opposite orders would otherwise close a deadlock cycle as soon as an erasure queued exclusively between them.
