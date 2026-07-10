-- SPDX-License-Identifier: Apache-2.0
-- Compatibility wrapper: the canonical role/grant SQL ships with @3ngram/db
-- so Railway pre-deploy can run migrations and grants from the production image.
\ir ../packages/db/provision-roles.sql
