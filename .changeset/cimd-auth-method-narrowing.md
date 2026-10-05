---
"@3ngram/schema": patch
"@3ngram/server": patch
---

Accept CIMD clients that prefer an unsupported token endpoint auth method but list `none` as supported. ChatGPT's connector now presents `client_id=https://chatgpt.com/oauth/client.json`, whose document declares `token_endpoint_auth_method: "private_key_jwt"` with `token_endpoint_auth_methods_supported: ["none", "private_key_jwt"]`. The schema pinned the method to the literal `none`, so the whole document failed as `metadata_invalid_document` and `/oauth/authorize` answered a bare `400 invalid_client`. The supported list is now authoritative when present and must include `none`; without it the declared method must be `none` or absent. The parsed document is still always a public client, so `/token` and the `oauth_clients` row are unchanged. Live documents for ChatGPT, claude.ai and Claude Code are pinned as schema test fixtures.
