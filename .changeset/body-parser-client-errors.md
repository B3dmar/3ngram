---
"@3ngram/server": patch
---

Map every body-parser rejection to its client error instead of the generic 500 (#301). `express.json()` runs before any route, and until now only a malformed JSON body (`entity.parse.failed`) was special-cased to 400 `invalid_request`; an oversized body or an unsupported content encoding fell through to 500 `internal_error` and was logged as an unhandled server error. A body over the 100 KB default limit now returns 413 `payload_too_large`, an unsupported `Content-Encoding` or charset returns 415 `unsupported_media_type`, a corrupt or truncated compressed body (which body-parser wraps as a 400 with only the zlib `Z_*` code) and any other body-parser 4xx return 400 `invalid_request`, and each is logged at warn with the status and body-parser type only, never the body. Applies to `/mcp` and `/api/v1` alike, since both sit behind the same app-level parser.
