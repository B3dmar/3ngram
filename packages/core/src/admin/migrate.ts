// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runMigrations } from '@3ngram/db/migrate'

export { runMigrations }

function isEntrypoint(): boolean {
  const entrypoint = process.argv[1]
  return entrypoint !== undefined && fileURLToPath(import.meta.url) === realpathSync(entrypoint)
}

if (isEntrypoint()) {
  runMigrations()
    .then(() => {
      process.stdout.write('db:migrate: complete\n')
    })
    .catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      process.stderr.write(
        `db:migrate: failed ${JSON.stringify({ error_type: error.name, message: error.message })}\n`,
      )
      process.exitCode = 1
    })
}
