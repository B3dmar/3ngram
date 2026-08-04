#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Guard: `import * as x from '<cjs-package>'` is a production-only landmine.
//
// Node's ESM interop synthesizes named exports for a CJS dependency by running
// cjs-module-lexer over its source, which only recognizes assignments it can
// scan statically. A whole-object assignment (`module.exports = thing`) yields
// no USABLE named exports, so `import * as x` produces a namespace whose real
// members are `undefined` and the first call throws TypeError at runtime.
//
// Vitest does not see this: Vite pre-bundles CJS dependencies through its own
// interop layer and synthesizes the named exports, so the module shape under
// test is not the shape the deployed runtime gets. That gap shipped a release
// in which every CIMD client resolution failed (ipaddr.js 2.4.0 — CJS, no
// `exports` map), disguised as `dns_failure` by a catch-all.
//
// Detection is by MEMBER USE, not by export count: ipaddr.js's namespace is not
// empty — cjs-module-lexer emits a literal key named `module.exports` — so
// "has some named export" is a false pass. This check asserts that every member
// the source actually reads off the namespace exists on it under REAL Node ESM
// resolution.
//
// Usage:
//   node scripts/check-cjs-namespace-imports.mjs
//   node scripts/check-cjs-namespace-imports.mjs --self-test
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_ROOTS = ['packages', 'apps']
// `import * as name from 'specifier'` where specifier is a BARE package name
// (not relative, not node: builtin — those have real ESM namespaces).
const NAMESPACE_IMPORT = /^\s*import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'".][^'"]*)['"]/gm

async function* sourceFiles(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      yield* sourceFiles(full)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      yield full
    }
  }
}

/** Every (file, local alias, bare specifier) namespace import in the sources. */
async function collectNamespaceImports() {
  const found = []
  for (const root of SOURCE_ROOTS) {
    for await (const file of sourceFiles(join(repoRoot, root))) {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(NAMESPACE_IMPORT)) {
        const [, local, specifier] = match
        if (specifier.startsWith('node:')) continue
        found.push({ file, local, specifier, text })
      }
    }
  }
  return found
}

/**
 * Strip comments and string literals so a package name written in prose
 * (`ipaddr.js is CJS`) or in the import specifier is not mistaken for a member
 * access — that would flag `js` as missing and fail a perfectly good import.
 */
function stripCommentsAndStrings(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/**
 * Members read off the namespace alias. Covers BOTH shapes, because either one
 * yields `undefined` in production:
 *   - `ipaddr.isValid(x)`            -> 'isValid'
 *   - `const { isValid } = ipaddr`   -> 'isValid'
 * A destructure records no property access, so matching only `alias.member`
 * would let the exact failure mode this guard exists for slip through.
 */
function usedMembers(text, local) {
  const source = stripCommentsAndStrings(text)
  const members = new Set()

  const access = new RegExp(`\\b${local}\\.([A-Za-z_$][\\w$]*)`, 'g')
  for (const match of source.matchAll(access)) members.add(match[1])

  const destructure = new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${local}\\b`, 'g')
  for (const match of source.matchAll(destructure)) {
    for (const part of match[1].split(',')) {
      // `a`, `a: b`, `a = fallback`, `...rest` (a rest element consumes no
      // single named member, so it is skipped).
      const name = part.split(/[:=]/)[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) members.add(name)
    }
  }
  return members
}

/**
 * Import the specifier through REAL ESM resolution, from the importing file's
 * own directory so pnpm's per-package layout applies.
 *
 * Deliberately NOT createRequire().resolve(): that selects the package's
 * `require` export condition, which for a dual-published package (e.g.
 * @sentry/node) is a DIFFERENT file than the `import` condition Node actually
 * loads for `import * as`. Resolving the wrong branch would both miss real
 * breakage and fail valid imports. A throwaway sibling module gets the exact
 * resolution the deployment performs.
 */
async function namespaceOf(specifier, fromFile) {
  const probe = join(dirname(fromFile), `.esm-interop-probe-${randomUUID()}.mjs`)
  await writeFile(probe, `export * as namespace from ${JSON.stringify(specifier)}\n`)
  try {
    const probed = await import(pathToFileURL(probe).href)
    return probed.namespace
  } finally {
    await rm(probe, { force: true })
  }
}

async function run(selfTest) {
  if (selfTest) {
    // The guard is only meaningful if it still detects the known-bad shape.
    // ipaddr.js is CJS with `module.exports = ipaddr` and no `exports` map, so
    // a real member like `isValid` must be ABSENT from its ESM namespace.
    const probeFrom = join(repoRoot, 'packages/core/src/auth/client-metadata.ts')
    let namespace
    try {
      namespace = await namespaceOf('ipaddr.js', probeFrom)
    } catch (error) {
      process.stderr.write(`self-test could not resolve ipaddr.js: ${String(error)}\n`)
      process.exit(1)
    }
    if (Object.hasOwn(namespace, 'isValid')) {
      process.stderr.write(
        'self-test FAILED: ipaddr.js now exposes `isValid` as a named ESM export, so the ' +
          'known-bad shape this guard exists for is no longer reproducible here.\n',
      )
      process.exit(1)
    }
    process.stdout.write(
      'check-cjs-namespace-imports: self-test passed (ipaddr.js lacks a real named export)\n',
    )
  }

  const imports = await collectNamespaceImports()
  const failures = []

  for (const { file, local, specifier, text } of imports) {
    let namespace
    try {
      namespace = await namespaceOf(specifier, file)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${relative(repoRoot, file)}: could not import '${specifier}' (${message})`)
      continue
    }
    const missing = [...usedMembers(text, local)].filter((member) => !(member in namespace))
    if (missing.length > 0) {
      failures.push(
        `${relative(repoRoot, file)}: 'import * as ${local} from "${specifier}"' does not provide ` +
          `[${missing.join(', ')}] under Node ESM — undefined at runtime. Use a default import.`,
      )
    }
  }

  if (failures.length > 0) {
    process.stderr.write('CJS namespace-import check FAILED:\n\n')
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`)
    process.stderr.write(
      '\nA CJS dependency assigned via `module.exports = …` has no statically\n' +
        'detectable named exports, so `import * as` yields unusable members in\n' +
        'production even though the test suite passes. Use `import name from "…"`.\n',
    )
    process.exit(1)
  }

  process.stdout.write(`check-cjs-namespace-imports: ${imports.length} namespace import(s) OK\n`)
}

await run(process.argv.includes('--self-test'))
