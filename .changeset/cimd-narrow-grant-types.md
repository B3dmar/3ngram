---
'@3ngram/schema': patch
---

Stop rejecting a Client ID Metadata Document because it advertises a grant type this server does not implement.

`clientIdMetadataDocumentSchema` validated `grant_types` as `z.array(z.enum(['authorization_code','refresh_token'])).max(2)`, so any document listing a third grant failed structurally and the client could not authorize at all. That locked out real MCP clients: claude.ai's document advertises `urn:ietf:params:oauth:grant-type:jwt-bearer` alongside the two grants we support, failing both the enum and the `max(2)` cap and producing a bare `400 invalid_client`.

`grant_types` and `response_types` advertise what a client MAY use (RFC 7591 §2). MCP's CIMD requirements for an authorization server are to validate that `client_id` matches the document URL, to validate `redirect_uris`, and to validate that the structure is valid JSON containing the required fields — `client_id`, `client_name`, `redirect_uris`. `grant_types` is not among them, and nothing licenses condemning a whole document over one unsupported entry.

Both fields are now parsed permissively and narrowed to what this server issues. The bound stays on the raw array, since unbounded input is the actual risk; the narrowed result is by construction no larger than the supported set. Narrowing to an empty list is allowed deliberately: usability is a policy question the `/authorize` path already answers with a precise `unsupported_grant_type`, rather than a blanket `invalid_document` from the structural boundary. Structurally malformed advertisements (a non-array, or an empty array) are still rejected, and the absent-field default is unchanged.
