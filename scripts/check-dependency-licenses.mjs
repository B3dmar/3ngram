// SPDX-License-Identifier: Apache-2.0
// Fail-closed production dependency license inventory.
//
// pnpm derives this report from the exact frozen workspace graph. A new license
// expression must be reviewed and explicitly added here; unknown, missing, or
// copyleft categories never pass by accident.
import { spawnSync } from 'node:child_process'

const ALLOWED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'MIT-0',
])

export function rejectedLicenses(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new TypeError('license report must be an object')
  }
  return Object.keys(report)
    .filter((license) => !ALLOWED_LICENSES.has(license))
    .sort()
}

function selfTest() {
  if (rejectedLicenses({ MIT: [], 'Apache-2.0': [] }).length !== 0) {
    throw new Error('self-test: allowed licenses were rejected')
  }
  const rejected = rejectedLicenses({ MIT: [], GPL: [], UNKNOWN: [] })
  if (rejected.join(',') !== 'GPL,UNKNOWN') {
    throw new Error('self-test: unapproved licenses were not rejected')
  }
  process.stdout.write('dependency-licenses self-test: OK\n')
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }

  const result = spawnSync('pnpm', ['licenses', 'list', '--json', '--prod'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    throw new Error(`pnpm licenses exited with status ${result.status}`)
  }

  const report = JSON.parse(result.stdout)
  const rejected = rejectedLicenses(report)
  if (rejected.length > 0) {
    process.stderr.write(
      `ERROR: unapproved production dependency licenses: ${rejected.join(', ')}\n`,
    )
    process.exitCode = 1
    return
  }

  const dependencyCount = Object.values(report).reduce(
    (count, packages) => count + (Array.isArray(packages) ? packages.length : 0),
    0,
  )
  process.stdout.write(
    `dependency-licenses: OK (${dependencyCount} package entries; ${Object.keys(report).length} approved licenses)\n`,
  )
}

main()
