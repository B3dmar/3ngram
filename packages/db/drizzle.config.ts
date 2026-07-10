// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema',
  out: './migrations',
  dbCredentials: {
    // Migrations ALWAYS use the unpooled/direct URL.
    url: process.env.DATABASE_URL_UNPOOLED ?? '',
  },
})
