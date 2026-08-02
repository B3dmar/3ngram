// SPDX-License-Identifier: Apache-2.0
// DuplicateEmailError: provisioning error surface; AuditLogEntry+insertAuditLog:
// re-exported to keep apps/* off @3ngram/db (layering hard rule 5)

export {
  type AuditLogEntry,
  DuplicateEmailError,
  insertAuditLog,
  ResourceLimitExceededError,
} from '@3ngram/db'
export {
  type ApiKeyMetadata,
  authenticateApiKey,
  hashApiKey,
  type IssuedApiKey,
  issueApiKey,
  listApiKeys,
  revokeApiKey,
  touchApiKeyLastUsed,
} from './api-keys.js'
export {
  type ClientMetadataAddress,
  type ClientMetadataDocumentFetcher,
  ClientMetadataError,
  type ClientMetadataFailure,
  type ClientMetadataFetchOptions,
  type ClientMetadataFetchResult,
  type ClientMetadataHostnameResolver,
  type ClientMetadataHttpResponse,
  type ClientMetadataPinnedGet,
  ClientMetadataResolver,
  type ClientMetadataResolverOptions,
  fetchClientMetadataDocument,
  isPublicClientMetadataAddress,
} from './client-metadata.js'
export {
  InvalidEmailVerificationTokenError,
  requestEmailVerification,
  requestSignup,
  resendEmailVerification,
  verifyEmail,
} from './email-verification.js'
export {
  assertSigningKeysUsable,
  derivePublicJwks,
  MEMORY_READ_SCOPE,
  MEMORY_WRITE_SCOPE,
  type MemoryScope,
  type OAuthJwk,
  type OAuthVerifyConfig,
  parseScopes,
  rotateKeyArray,
  type SignAccessTokenParams,
  signAccessToken,
  type VerifiedAccessToken,
  type VerifyFailure,
  type VerifyResult,
  verifyAccessToken,
} from './oauth.js'
export {
  type AuthorizedClientView,
  authenticateClientCredentials,
  hashClientSecret,
  listAuthorizedClients,
  type OAuthClientInformation,
  type OAuthClientsStore,
  oauthClientsStore,
  registerOAuthClient,
  resolveOAuthClient,
  revokeAuthorizedClient,
  touchClientLastUsed,
} from './oauth-clients.js'
export {
  ACCESS_TOKEN_TTL_SECONDS,
  type AuthorizeCodeGrant,
  buildAuthorizationResponseUrl,
  createOAuthServerProvider,
  OAuthGrantError,
  type OAuthGrantFailure,
  type OAuthServerProviderShape,
  type OAuthTokenResponse,
  type RedirectCapable,
  resolveRegisteredRedirectUri,
  supportsAuthorizationResponseIssuer,
  type VerifiedTokenInfo,
} from './oauth-provider.js'
export { getOnboardingStatus, type OnboardingStatus } from './onboarding.js'
export { hashPassword, verifyPassword } from './password.js'
export {
  assertPasswordNotBreached,
  type BreachCheckLogger,
  type PasswordBreachCheckOptions,
  PasswordBreachedError,
  type PwnedRangeFetcher,
} from './password-breach.js'
export { getUserProfile, setUserProfile } from './profile.js'
export { provisionVerifiedAccount } from './provisioning.js'
export {
  InvalidResetTokenError,
  requestPasswordReset,
  resetPassword,
} from './reset-tokens.js'
export {
  authenticateToken,
  changePasswordAndRevokeOthers,
  EmailNotVerifiedError,
  issueSession,
  login,
  type SessionGrant,
  verifyCredentials,
} from './sessions.js'
export {
  changePassword,
  createUnverifiedUser,
  createUser,
  InvalidCurrentPasswordError,
  type ProvisionedUser,
  verifyCurrentPasswordHash,
} from './users.js'
