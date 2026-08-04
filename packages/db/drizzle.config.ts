// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema',
  out: './migrations',
  // Platform billing owns these tables. OSS DB introspection/push must ignore
  // them; the generated OSS snapshot baseline likewise excludes them.
  tablesFilter: ['!stripe_events', '!subscriptions'],
  dbCredentials: {
    // Migrations ALWAYS use the unpooled/direct URL.
    url: process.env.DATABASE_URL_UNPOOLED ?? '',
  },
})
