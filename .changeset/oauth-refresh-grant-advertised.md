---
"@3ngram/core": patch
"@3ngram/db": patch
---

Stop issuing refresh tokens to OAuth clients that never advertised the `refresh_token` grant (issue #86).

The authorization-code exchange minted a refresh token unconditionally, but the token route gates the refresh grant on the client's advertised `grant_types`. A client registered for `authorization_code` alone — which is also the schema default when a CIMD document omits `grant_types` entirely — therefore received a refresh token that the very next request rejected as `invalid_client`. Nothing in the token response signalled that, so the client had no way to know the credential was inert until it tried to use it and lost its session.

Issuance now matches what the authorization server will actually honour: the refresh token is omitted from the response and its hash is not persisted, since a hash for a token no client was ever handed can never be presented or rotated. `refresh_token` on the token response is now optional, which is what RFC 6749 §5.1 always specified.

Rotation additionally fails closed if a client's advertised grants are narrowed between issuance and rotation, rather than revoking the predecessor and minting no successor.

This predates the CIMD grant-type narrowing in #85 — `grant_types: ['authorization_code']` has always been accepted.
