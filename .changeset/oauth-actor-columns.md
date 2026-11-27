---
"@3ngram/db": minor
"@3ngram/core": patch
---

Record the login that authorized an OAuth grant for a different account (issue #506). A nullable `actor_user_id` on `oauth_codes` and `oauth_tokens` (migration 0048, foreign key to `users` with cascade) is copied from the code to the token pair it is exchanged for, and from each rotated refresh token to its successor, so a whole token family names its actor and a refresh can neither drop nor change it. Nothing sets it yet: a login authorizing itself, which is every grant today, leaves it NULL, and token behaviour is unchanged.

`@3ngram/db`: `NewOauthCode` and `NewOauthToken` gain an optional `actorUserId`, and `oauthCodeActor(userId, codeHash)` reads a consumed code's actor (tenant-scoped, with an explicit `user_id` predicate): `null` for a code with no actor, `undefined` when the code is gone, in which case the exchange fails with `invalid_grant` instead of issuing an unattributed pair. `rotateOauthRefreshToken` ignores any `actorUserId` the caller passes and carries the predecessor's. The SECURITY DEFINER resolvers are unchanged.
