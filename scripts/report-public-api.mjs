// SPDX-License-Identifier: Apache-2.0
//
// Cross-repo public-API report generator.
// Emits a DETERMINISTIC export-surface listing of the six-package @3ngram
// closure the private `3ngram-platform` repo consumes (per the cross-repo
// contract maintained in that private repo),
// derived from the LIVE dependency graph (BFS from `@3ngram/server` — never a
// hardcoded list) and the built `dist/*.d.ts` of each
// `exports` entry, into docs/reference/public-api-report.md.
//
// Run it through the root pipeline, which builds the closure first:
//   pnpm run docs:generate
// or standalone, after building the closure yourself:
//   pnpm --filter "@3ngram/server..." run build
//   node scripts/report-public-api.mjs
//
// FRESHNESS: this is the last step of the root `docs:generate` script, so the
// existing `docs-reference` CI lane (which runs `pnpm run docs:generate` and
// then `git diff --exit-code -- docs`) covers the report byte for byte. It was
// manual-run at first and went stale twice, because a changed export surface
// looks like an unrelated PR until the diff is missing. There is no separate
// gate to add: the blocking cross-repo check is still the private repo's CI
// installing the `@3ngram/*@next` snapshot prereleases and going red on an
// incompatible surface — this artifact just cannot lag it any more. Uses the
// repo's own `typescript` — no new dependencies.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
// pnpm keeps node_modules unhoisted — resolve the repo's own `typescript`
// through a workspace package that declares it (no new dependency).
const require = createRequire(path.join(ROOT, 'apps/server/package.json'))
const ts = require('typescript')
const ROOT_PACKAGE = '@3ngram/server'
const REPORT = 'docs/reference/public-api-report.md'

// Locale-independent comparator: the report must be byte-identical across
// machines, and String.prototype.localeCompare depends on the host ICU/locale.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

const out = (s) => process.stdout.write(`${s}\n`)
const fail = (s) => {
  process.stderr.write(`report-public-api: ${s}\n`)
  process.exit(1)
}

/** All workspace packages as name -> { dir, manifest }. */
function workspacePackages() {
  const found = new Map()
  for (const glob of ['apps', 'packages']) {
    const base = path.join(ROOT, glob)
    for (const entry of readdirSync(base)) {
      const manifestPath = path.join(base, entry, 'package.json')
      let source
      try {
        source = readFileSync(manifestPath, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
        throw error
      }
      const manifest = JSON.parse(source)
      found.set(manifest.name, { dir: path.join(glob, entry), manifest })
    }
  }
  return found
}

/** BFS the runtime dep graph from the root package: the publish closure. */
function deriveClosure(packages) {
  if (!packages.has(ROOT_PACKAGE)) fail(`workspace package ${ROOT_PACKAGE} not found`)
  const closure = new Set([ROOT_PACKAGE])
  const queue = [ROOT_PACKAGE]
  while (queue.length > 0) {
    const { manifest } = packages.get(queue.shift())
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (dep.startsWith('@3ngram/') && packages.has(dep) && !closure.has(dep)) {
        closure.add(dep)
        queue.push(dep)
      }
    }
  }
  return [...closure].sort()
}

/** [subpath, absolute .d.ts path] for each typed `exports` entry of a package. */
function typedEntryPoints(pkg) {
  const entries = []
  for (const [subpath, target] of Object.entries(pkg.manifest.exports ?? {})) {
    if (typeof target !== 'object' || target === null || !target.types) continue
    entries.push([subpath, path.join(ROOT, pkg.dir, target.types)])
  }
  return entries.sort(([a], [b]) => byCodeUnit(a, b))
}

/** Alias-resolved symbol (falls back to the alias itself if unresolvable). */
function resolveAlias(symbol, checker) {
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      return checker.getAliasedSymbol(symbol)
    } catch {
      /* unresolvable alias: classify the alias itself */
    }
  }
  return symbol
}

/** Stable kind label for an exported symbol (alias-resolved). */
function kindOf(symbol, checker) {
  const s = resolveAlias(symbol, checker)
  const f = s.flags
  if (f & ts.SymbolFlags.Class) return 'class'
  if (f & ts.SymbolFlags.Enum) return 'enum'
  if (f & ts.SymbolFlags.Function) return 'function'
  if (f & ts.SymbolFlags.Interface) return 'interface'
  if (f & ts.SymbolFlags.TypeAlias) return 'type'
  if (f & ts.SymbolFlags.Variable) return 'const'
  if (f & ts.SymbolFlags.Module) return 'namespace'
  return 'value'
}

/**
 * Stable signature hash for an exported symbol: sha256 (first 12 hex chars)
 * over the sorted declaration texts in the built .d.ts, so a retyped symbol
 * changes its report row even when name and kind stay identical (the
 * "retyped consumed symbol" scenario).
 */
function signatureOf(symbol, checker) {
  const declarations = resolveAlias(symbol, checker).getDeclarations() ?? []
  if (declarations.length === 0) return 'n/a'
  const texts = declarations.map((d) => d.getText().replace(/\s+/g, ' ').trim()).sort()
  return createHash('sha256').update(texts.join('\n')).digest('hex').slice(0, 12)
}

/** Sorted [name, kind, signature] triples exported from one entry .d.ts. */
function exportSurface(entryFile, program, checker) {
  const source = program.getSourceFile(entryFile)
  if (!source)
    fail(
      `built declaration missing: ${path.relative(ROOT, entryFile)} — run: pnpm --filter "@3ngram/server..." run build`,
    )
  const moduleSymbol = checker.getSymbolAtLocation(source)
  if (!moduleSymbol) return []
  return checker
    .getExportsOfModule(moduleSymbol)
    .map((sym) => [sym.getName(), kindOf(sym, checker), signatureOf(sym, checker)])
    .sort(([a], [b]) => byCodeUnit(a, b))
}

function renderReport(sections) {
  const lines = [
    '<!-- SPDX-License-Identifier: Apache-2.0 -->',
    '<!-- GENERATED by scripts/report-public-api.mjs — do not edit by hand. -->',
    '',
    '# Public API report — the @3ngram publish closure',
    '',
    'Deterministic export surface of the six packages published under `@3ngram`.',
    'Regenerate it with the rest of the reference docs (this is the last step of',
    'the root `docs:generate` script, and the `docs-reference` CI lane diffs the',
    'result byte for byte):',
    '',
    '```sh',
    'pnpm run docs:generate',
    '```',
    '',
    '**How the contract gate consumes this** (the blocking half runs in the private',
    "repo's CI, not here): the public side publishes `@3ngram/*@next` snapshot",
    'prereleases on staging merges touching the closure; stable lane:',
    '[`.github/workflows/release-publish.yml`](../../.github/workflows/release-publish.yml)).',
    "The private repo's CI installs `@3ngram/*@next`, builds + runs its suite, and",
    'diffs the surface it imports against this committed artifact — a removed or',
    'retyped consumed symbol goes red **before** any stable publish or deploy',
    "(SC-005). This file regenerates in the PR that changes a closure package's",
    'exports, so the diff is reviewable where the change happens.',
    '',
    'The `Signature` column is a sha256 hash (first 12 hex chars) over the',
    "export's declaration text in the built `.d.ts`, so a retyped symbol changes",
    'its row here even when its name and kind are unchanged.',
    '',
  ]
  for (const { name, version, entries } of sections) {
    lines.push(`## \`${name}\` ${version}`, '')
    for (const { subpath, surface } of entries) {
      lines.push(`### \`${subpath}\``, '')
      if (surface.length === 0) {
        lines.push('_No exports._', '')
        continue
      }
      lines.push('| Export | Kind | Signature |', '|---|---|---|')
      for (const [exportName, kind, signature] of surface)
        lines.push(`| \`${exportName}\` | ${kind} | \`${signature}\` |`)
      lines.push('')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function main() {
  const packages = workspacePackages()
  const closure = deriveClosure(packages)
  const perPackageEntries = closure.map((name) => [name, typedEntryPoints(packages.get(name))])
  const allEntryFiles = perPackageEntries.flatMap(([, entries]) => entries.map(([, f]) => f))
  const program = ts.createProgram(allEntryFiles, { skipLibCheck: true })
  const checker = program.getTypeChecker()

  const sections = perPackageEntries.map(([name, entries]) => ({
    name,
    version: packages.get(name).manifest.version,
    entries: entries.map(([subpath, file]) => ({
      subpath,
      surface: exportSurface(file, program, checker),
    })),
  }))

  writeFileSync(path.join(ROOT, REPORT), renderReport(sections))
  const total = sections.reduce(
    (n, s) => n + s.entries.reduce((m, e) => m + e.surface.length, 0),
    0,
  )
  out(`report-public-api: ${REPORT} written — ${closure.length} packages, ${total} exports`)
  out(`  closure: ${closure.join(', ')}`)
}

main()
