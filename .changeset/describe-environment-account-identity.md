---
"@3ngram/server": minor
"@3ngram/schema": minor
"@3ngram/core": minor
"@3ngram/db": minor
---

`describe_environment` now names the authenticated account (issue #321). The report carries `account: { id }`, the uuid of the 3ngram account the token authenticated as — the same value `GET /api/v1/me` returns as `id`, stable for the account's lifetime across every OAuth client and API key, and different for every account. It is read from the live account record, not derived from a scope name or memory content, and it carries no email, display label or credential metadata. Two connectors that both show a `work` scope can now be told apart (or confirmed to be the same account) with a read-only call; `docs/concepts/scopes.mdx` documents the diagnostic and why identity, filing scope/project and read policy are separate. A request whose account has been erased gets no id: erasure already revokes its tokens, and a request already in flight is answered `account_deleted`. New exports: `describeEnvironmentOutputV3Schema` and `accountIdentitySchema` (`@3ngram/schema`), `getLiveAccountId` (`@3ngram/db`), and the `account` field on core's `EnvironmentReport`. The tool description is unchanged.
