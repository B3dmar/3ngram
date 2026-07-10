<!-- SPDX-License-Identifier: Apache-2.0 -->

# @3ngram/db

The Drizzle schema, migrations, tenant-scoped access layer, and PostgreSQL role
provisioning for 3ngram. All application database access is designed to pass
through `withTenant()`; self-hosting also requires the bundled migrations and
role grants.

Use this package as part of the documented 3ngram deployment rather than as a
generic ORM wrapper. See the
[3ngram repository](https://github.com/B3dmar/3ngram) for database safety and
migration instructions.
