// SPDX-License-Identifier: Apache-2.0
// Identity & access tables.
//
// RLS applies to every user-owned table here (user_sessions, api_keys,
// oauth_codes, oauth_tokens, password_reset_tokens, email_verification_tokens)
// — a missing WHERE user_id in service code must fail closed, same as the
// memory domain. The pre-tenant auth path (looking
// up a credential by hash BEFORE tenant context exists) does NOT get a
// blanket RLS exemption: it goes through narrow SECURITY DEFINER resolver
// functions (migrations/0003_auth_resolvers.sql), one per credential type.
// Only `users` (the identity itself) and `oauth_clients` (pre-auth DCR
// registrations plus CIMD FK materializations, no user_id) are true system tables.

import {
  type OAuthClientRegistrationMethod,
  oauthClientRegistrationMethodSchema,
  profileReferralSourceSchema,
  profileRoleSchema,
  profileUseCaseSchema,
  type TokenEndpointAuthMethod,
  tokenEndpointAuthMethodSchema,
} from '@3ngram/schema'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { enumCheckSql, tenantPolicy } from './helpers.js'

const uuidv7 = () => sql`uuidv7()`

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(uuidv7()),
  email: text('email').notNull().unique(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('user_sessions_user_idx').on(t.userId), tenantPolicy()],
)

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    prefix: text('prefix').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('api_keys_prefix_idx').on(t.prefix),
    index('api_keys_user_idx').on(t.userId),
    tenantPolicy(),
  ],
)

// OAuth client registry: authoritative DCR registrations (RFC 7591) plus CIMD
// materializations used only for grant foreign keys and connected-app display.
// DCR supports public AND confidential clients; CIMD v1 is public/PKCE only.
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    clientId: text('client_id').notNull().unique(),
    clientName: text('client_name').notNull(),
    redirectUris: jsonb('redirect_uris').notNull().$type<string[]>(),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method')
      .notNull()
      .default('none')
      .$type<TokenEndpointAuthMethod>(),
    clientSecretHash: text('client_secret_hash'),
    registrationMethod: text('registration_method')
      .notNull()
      .default('dynamic_registration')
      .$type<OAuthClientRegistrationMethod>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'oauth_clients_auth_method_check',
      enumCheckSql(t.tokenEndpointAuthMethod, tokenEndpointAuthMethodSchema.options),
    ),
    // confidential methods REQUIRE a stored secret hash; public forbids one
    check(
      'oauth_clients_secret_consistency_check',
      sql`(${t.tokenEndpointAuthMethod} = 'none' AND ${t.clientSecretHash} IS NULL)
        OR (${t.tokenEndpointAuthMethod} <> 'none' AND ${t.clientSecretHash} IS NOT NULL)`,
    ),
    check(
      'oauth_clients_registration_method_check',
      enumCheckSql(t.registrationMethod, oauthClientRegistrationMethodSchema.options),
    ),
  ],
)

// Single-use PKCE codes, <=60s TTL.
export const oauthCodes = pgTable(
  'oauth_codes',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    codeHash: text('code_hash').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    // RFC 6749 §4.1.3: was redirect_uri present in the /authorize request? A
    // single-registered-URI client MAY omit it, in which case redirectUri above
    // is the RESOLVED value — this bit distinguishes supplied from resolved so
    // the token endpoint can enforce "REQUIRED at token iff supplied at authorize".
    redirectUriSupplied: boolean('redirect_uri_supplied').notNull().default(false),
    codeChallenge: text('code_challenge').notNull(),
    scope: text('scope').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('oauth_codes_expires_idx').on(t.expiresAt), tenantPolicy()],
)

// Single-use forgotten-password reset tokens. Mirrors oauth_codes:
// only the SHA-256 hash is ever stored (token_hash UNIQUE, plaintext NEVER hits
// the DB), single-use via consumed_at, short TTL via expires_at. RLS ON like the
// other user-owned credential tables; the pre-tenant consume path goes through
// the SECURITY DEFINER auth_consume_password_reset_token resolver (0015), so a
// presented token can be resolved to its user BEFORE any tenant context exists.
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    tokenHash: text('token_hash').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('password_reset_tokens_expires_idx').on(t.expiresAt), tenantPolicy()],
)

// Access/refresh token state — stored hashed, prefix-indexed.
// Single-use email-verification tokens for public signup. Mirrors
// password_reset_tokens: only SHA-256 hashes are stored, rows are RLS-owned by
// user_id, and the pre-tenant verify path goes through a SECURITY DEFINER
// resolver in the migration. client_proof_hash binds the emailed token to the
// browser/client that supplied the pre-verification password.
export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    tokenHash: text('token_hash').notNull().unique(),
    clientProofHash: text('client_proof_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('email_verification_tokens_expires_idx').on(t.expiresAt),
    check(
      'email_verification_tokens_client_proof_hash_check',
      sql`${t.clientProofHash} ~ '^[0-9a-f]{64}$'`,
    ),
    tenantPolicy(),
  ],
)

export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: uuid('id').primaryKey().default(uuidv7()),
    tokenHash: text('token_hash').notNull().unique(),
    kind: text('kind').notNull(), // 'access' | 'refresh' — narrow, local; not a domain enum
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    rotatedFrom: uuid('rotated_from'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('oauth_tokens_user_client_idx').on(t.userId, t.clientId),
    uniqueIndex('oauth_tokens_rotation_idx').on(t.rotatedFrom).where(sql`rotated_from IS NOT NULL`),
    tenantPolicy(),
  ],
)

/**
 * Onboarding "About you" profiling. One optional row per
 * user (user_id PRIMARY KEY → upsert on conflict). Every attribute is nullable;
 * the user may answer some, all, or none. Enum columns carry CHECK constraints
 * generated from the @3ngram/schema Zod enums (single source); a NULL value
 * satisfies the `IN (...)` check (a CHECK only fails on FALSE). `ai_tools` is a
 * multi-select array, validated at the Zod boundary (no element CHECK here). RLS
 * scopes every row to its owner.
 */
export const userProfileAttributes = pgTable(
  'user_profile_attributes',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role'),
    useCase: text('use_case'),
    aiTools: text('ai_tools').array(),
    referralSource: text('referral_source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('user_profile_attributes_role_check', enumCheckSql(t.role, profileRoleSchema.options)),
    check(
      'user_profile_attributes_use_case_check',
      enumCheckSql(t.useCase, profileUseCaseSchema.options),
    ),
    check(
      'user_profile_attributes_referral_source_check',
      enumCheckSql(t.referralSource, profileReferralSourceSchema.options),
    ),
    tenantPolicy(),
  ],
)
