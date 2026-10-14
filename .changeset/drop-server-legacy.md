---
"@3ngram/server": patch
---

Remove the deprecated `@modelcontextprotocol/server-legacy` dependency. `POST /oauth/token` was its last user, and it now builds its RFC 6749 errors from `OAuthError` and `OAuthErrorCode` in `@modelcontextprotocol/server`. Every token-endpoint error response keeps the same HTTP status, JSON body, and headers, and the per-request outcome log line is unchanged; a new unit suite pins each error path byte for byte. With the package gone, `express-rate-limit` and `ip-address` leave the dependency graph, so the scoped `ip-address@<10.7.1` advisory override is dropped as well.
