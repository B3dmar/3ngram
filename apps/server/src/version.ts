// SPDX-License-Identifier: Apache-2.0
// Single source of truth for the server version. Derived from
// apps/server/package.json at runtime so the MCP `initialize` result
// (mcp/server.ts) and `describe_environment` (mcp/tools-admin.ts) ALWAYS equal
// the published package version and cannot skew at a release (previously two
// hardcoded '0.0.0' literals that went stale the moment package.json bumped).
//
// Safe to read at runtime here: the build is plain `tsc` (no bundler), so
// package.json ships beside dist/ and resolves relative to this module's
// compiled location — dist/version.js -> ../package.json, and equally
// src/version.ts -> ../package.json under the test runner. A static
// `import ... with { type: 'json' }` is NOT used because package.json sits
// outside tsconfig `rootDir` ("src"), which would break the dist layout.
import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

export const SERVER_VERSION = packageJson.version
