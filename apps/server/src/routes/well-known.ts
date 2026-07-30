// SPDX-License-Identifier: Apache-2.0
// OAuth resource-server discovery transport. Thin by contract:
// read the validated OAuth config, derive/serve metadata, no business
// logic. Three documents, all public (no auth — they are discovery surfaces):
//
//   GET /.well-known/jwks.json
//     The PUBLIC verification keys (RFC 7517). Derived from the env private key
//     array via core's derivePublicJwks — private material (`d`/`p`/`q`/...) is
//     NEVER serialized here.
//
//   GET /.well-known/oauth-protected-resource           (bare)
//   GET /.well-known/oauth-protected-resource/mcp       (RFC 9728 path-suffixed)
//     Protected-resource metadata (RFC 9728): advertises the resource id + its
//     authorization server (the issuer). RFC 9728 derives the well-known path
//     from the resource's own path, so the body served at each location must
//     name the resource that location is the discovery surface for: the bare
//     path is the discovery location for the ROOT resource (the issuer origin),
//     the `/mcp`-suffixed path is the discovery location for the `/mcp`
//     resource. A strict client discards a body whose `resource` does not match
//     the location it probed, so the two surfaces advertise different ids.
//
// loadOAuthConfig() fails fast at boot when keys/issuer are missing or invalid,
// so these handlers can assume a well-formed config.
import { loadOAuthConfig } from '@3ngram/config'
import {
  derivePublicJwks,
  MEMORY_READ_SCOPE,
  MEMORY_WRITE_SCOPE,
  supportsAuthorizationResponseIssuer,
} from '@3ngram/core/auth'
import { type Request, type Response, Router } from 'express'

export const wellKnownRouter: Router = Router()

wellKnownRouter.get('/.well-known/jwks.json', (_req: Request, res: Response) => {
  const config = loadOAuthConfig()
  res.status(200).json(derivePublicJwks(config.keys))
})

/** RFC 9728 protected-resource metadata: resource id + its authorization server. */
function protectedResourceMetadata(resource: string): {
  resource: string
  authorization_servers: string[]
} {
  const config = loadOAuthConfig()
  return {
    resource,
    authorization_servers: [config.issuer],
  }
}

// Bare path = discovery location for the ROOT resource (the issuer origin, no
// trailing slash). The issuer is normalized with a trailing slash; the root
// resource id drops it so a strict client's location/resource match holds.
wellKnownRouter.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
  const config = loadOAuthConfig()
  const rootResource = config.issuer.replace(/\/$/, '')
  res.status(200).json(protectedResourceMetadata(rootResource))
})

// Path-suffixed form (RFC 9728): discovery location for the `/mcp` resource.
// Advertises the `/mcp` resource id so a strict client's location/resource
// match holds.
wellKnownRouter.get('/.well-known/oauth-protected-resource/mcp', (_req: Request, res: Response) => {
  const config = loadOAuthConfig()
  res.status(200).json(protectedResourceMetadata(config.resource))
})

// RFC 8414 authorization-server metadata.
// MIRRORS the SDK router's createOAuthMetadata shape (the SDK auth router is
// not mounted — its token handler's plaintext client auth cannot work against
// hashed-at-rest secrets, so the endpoints are served by our own thin routes).
// `issuer` is the loadOAuthConfig().issuer string VERBATIM — the exact value
// the RS discovery documents advertise as authorization_servers[0] and the
// exact `iss` minted into access tokens, so a strict client's issuer
// consistency check holds across all three surfaces.
wellKnownRouter.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
  const config = loadOAuthConfig()
  res.status(200).json({
    issuer: config.issuer,
    authorization_response_iss_parameter_supported: supportsAuthorizationResponseIssuer(
      config.issuer,
    ),
    authorization_endpoint: new URL('/oauth/authorize', config.issuer).href,
    token_endpoint: new URL('/oauth/token', config.issuer).href,
    registration_endpoint: new URL('/oauth/register', config.issuer).href,
    client_id_metadata_document_supported: true,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    scopes_supported: [MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE],
  })
})
