// SPDX-License-Identifier: Apache-2.0
// Fail-closed audit of the pnpm-workspace.yaml `overrides:` block.
//
// An advisory override is a claim: "no resolution of this package may sit in
// the selector's range." The claim is never re-checked after the lockfile is
// written, so an override can stop holding without anything failing — the
// resolution it was meant to move stays put and CI keeps passing on
// --frozen-lockfile. Three outcome-based invariants close that gap:
//
//   NOT APPLIED — a version resolved in the lockfile still satisfies the
//     override's own selector. The override names that version as unwanted and
//     did not move it. This is the optional-peer failure mode recorded in
//     apps/server/CHANGELOG.md: pnpm overrides cannot reach a dependency that
//     arrives as an auto-installed optional peer, so the entry looks correct in
//     the workspace file while the graph never moves.
//
//   ORPHANED — the overridden package is absent from the lockfile entirely.
//     The entry is dead weight: it documents a constraint on a package this
//     workspace no longer resolves, and it will not protect a future
//     reintroduction at the version its author had in mind.
//
//   INERT — the package is present, but neither the selector's version line nor
//     the replacement target reaches anything resolved. The entry governs a
//     region of the version space this workspace left behind. Both halves must
//     miss: a deliberate cross-major rewrite empties its own selector line by
//     design and stays live through its target.
//
// All three invariants are deliberately stated as OUTCOMES rather than as claims
// about the selector, because pnpm matches an override selector against the
// parent's DECLARED range before resolution, not against the resolved version.
// An override therefore routinely applies while no resolved version satisfies
// its selector. "Selector matches nothing in the lockfile" is the normal state
// of a working override, not evidence of staleness — the question a future
// maintainer asks first, and the reason none of the three invariants is
// phrased as a claim about the selector alone.
//
// The boundary is range INTERSECTION, measured against a parent declaring
// `postcss@^8.5.6` (pnpm 11.9.0, resolutions observed in the lockfile):
//
//   <=8.5.22  overlaps ^8.5.6           -> applied (though 8.5.23 resolved,
//                                          which the selector excludes)
//   >=8.9.0   overlaps ^8.5.6           -> applied
//   <8.5.0    no overlap, same major    -> NOT applied
//   <8.0.0    no overlap, lower major   -> NOT applied
//
// The third row is the one worth keeping: sharing a major line is not enough,
// so the application boundary is intersection and not the parent's major line.
// Reading only the committed lockfile keeps the check independent of all of
// this. See CONTRIBUTING.md, "Dependency overrides".
import { readFileSync } from 'node:fs'

const WORKSPACE_FILE = 'pnpm-workspace.yaml'
const LOCKFILE = 'pnpm-lock.yaml'

// Deliberately minimal: the grammar below covers exactly the comparator forms
// used in this repo's overrides block. Anything else throws rather than
// silently mis-parsing into a range that matches nothing — a check that
// quietly stops checking is the failure it exists to catch.
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/
const COMPARATOR = /^(\^|>=|<=|>|<)?(\d+\.\d+\.\d+)$/
// A parent>child separator, distinguished from a comparator by what follows the
// `>`: a package-name character for `qar@1>zoo`, but `=` or a digit for the
// `>=1.0.0` and `>1.0.0` comparator forms. Matching a bare `>` would silently
// drop every strict-greater-than selector from the audit.
const PARENT_SELECTOR = />(?!=)(?!\d)/

export function parseVersion(text) {
  const match = VERSION.exec(text.trim())
  if (match === null) {
    throw new TypeError(`unsupported version: ${text}`)
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1
    }
  }
  return 0
}

function satisfiesComparator(version, comparator) {
  const match = COMPARATOR.exec(comparator)
  if (match === null) {
    throw new TypeError(`unsupported range comparator: ${comparator}`)
  }
  const [, operator = '', bound] = match
  const order = compareVersions(version, bound)
  switch (operator) {
    case '':
      return order === 0
    case '>':
      return order > 0
    case '>=':
      return order >= 0
    case '<':
      return order < 0
    case '<=':
      return order <= 0
    case '^': {
      if (order < 0) {
        return false
      }
      const [major, minor] = parseVersion(bound)
      const [versionMajor, versionMinor] = parseVersion(version)
      // Caret on a 0.x release only admits the same minor (npm semantics).
      if (major !== versionMajor) {
        return false
      }
      return major !== 0 || minor === versionMinor
    }
    default:
      throw new TypeError(`unsupported range operator: ${operator}`)
  }
}

// Space-separated comparators are a conjunction (`>=4.0.0 <4.3.1`).
export function satisfies(version, range) {
  return range
    .trim()
    .split(/\s+/)
    .every((comparator) => satisfiesComparator(version, comparator))
}

// The compatibility line a version belongs to. For 0.x releases that is the
// MINOR, following npm's caret convention (^0.28.1 admits 0.28.x but stops at
// 0.29.0), not the major. Bucketing 0.x by major would put every 0.anything in
// one line, so a dead 0.x entry would always find some resolved neighbour and
// never be flagged — the false negative that both esbuild entries would hit.
export function versionLine(version) {
  const [major, minor] = parseVersion(version)
  return major === 0 ? [0, minor] : [major]
}

export function sameLine(version, line) {
  const [major, minor] = parseVersion(version)
  if (line.length === 1) {
    return major === line[0]
  }
  return major === 0 && minor === line[1]
}

// Every line a selector's comparator bounds reach into: `>=0.27.3 <0.28.1`
// touches both 0.27.x and 0.28.x, and a resolved version in either keeps it live.
export function selectorLines(range) {
  return range
    .trim()
    .split(/\s+/)
    .map((comparator) => {
      const match = COMPARATOR.exec(comparator)
      if (match === null) {
        throw new TypeError(`unsupported range comparator: ${comparator}`)
      }
      return versionLine(match[2])
    })
}

function stripQuotes(text) {
  const trimmed = text.trim()
  const quote = trimmed[0]
  if ((quote === "'" || quote === '"') && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

// `name@range` where name may be scoped (`@scope/name@range`), so split on the
// last `@`. A bare `name` key (no selector) means "every version".
export function parseSelector(key) {
  const separator = key.lastIndexOf('@')
  if (separator <= 0) {
    return { name: key, range: null }
  }
  return { name: key.slice(0, separator), range: key.slice(separator + 1) }
}

export function parseOverrides(source) {
  const lines = source.split('\n')
  const start = lines.indexOf('overrides:')
  if (start === -1) {
    return []
  }
  const overrides = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue
    }
    // A non-indented line ends the block.
    if (!/^\s/.test(line)) {
      break
    }
    const separator = line.lastIndexOf(': ')
    if (separator === -1) {
      throw new TypeError(`unparsable override entry: ${line}`)
    }
    const key = stripQuotes(line.slice(0, separator))
    const replacement = stripQuotes(line.slice(separator + 2))
    // A parent-scoped selector (`qar@1>zoo`) constrains one edge rather than
    // the whole graph, so the lockfile-wide invariants below do not apply.
    // Comparator selectors are NOT parent-scoped — see PARENT_SELECTOR.
    if (PARENT_SELECTOR.test(key)) {
      continue
    }
    overrides.push({ ...parseSelector(key), replacement, key })
  }
  return overrides
}

// Resolved versions live in the lockfile's `packages:` section, whose keys are
// clean `name@version` pairs. `snapshots:` keys carry peer suffixes and would
// need extra unwrapping for no additional signal.
export function parseResolvedVersions(source) {
  const lines = source.split('\n')
  const start = lines.indexOf('packages:')
  if (start === -1) {
    throw new TypeError('lockfile has no packages: section')
  }
  const resolved = new Map()
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      continue
    }
    if (!/^\s/.test(line)) {
      break
    }
    const match = /^ {2}('?)((?:@[^/]+\/)?[^@'\s]+)@(\d+\.\d+\.\d+[^':\s]*)\1:$/.exec(line)
    if (match === null) {
      continue
    }
    // Prerelease/build-tagged versions are kept here rather than filtered:
    // dropping one silently could invent an ORPHANED finding (if it were the
    // only resolution) or hide a NOT APPLIED one. findStaleOverrides rejects
    // them for overridden packages; for every other package they are inert.
    const [, , name, version] = match
    const versions = resolved.get(name)
    if (versions === undefined) {
      resolved.set(name, [version])
      continue
    }
    versions.push(version)
  }
  return resolved
}

export function findStaleOverrides(overrides, resolved) {
  const findings = []
  for (const override of overrides) {
    const versions = resolved.get(override.name)
    if (versions === undefined || versions.length === 0) {
      findings.push({ kind: 'ORPHANED', override, versions: [] })
      continue
    }
    // Fail closed rather than guess: the comparator grammar below covers plain
    // X.Y.Z only, so a prerelease or build-tagged resolution of an OVERRIDDEN
    // package cannot be judged either way and must not be quietly skipped.
    for (const version of versions) {
      if (!VERSION.test(version)) {
        throw new TypeError(
          `unsupported resolved version for overridden package ${override.name}: ${version}`,
        )
      }
    }
    const unmoved = versions.filter(
      (version) => override.range === null || satisfies(version, override.range),
    )
    if (unmoved.length > 0) {
      findings.push({ kind: 'NOT APPLIED', override, versions: unmoved })
      continue
    }

    // INERT: the selector's version line holds nothing this workspace resolves
    // AND the replacement landed on nothing either, so the entry constrains no
    // edge that exists. Both halves are required: a deliberate cross-major
    // rewrite (`js-yaml@>=5.0.0 <5.2.4: ^4.3.1`) leaves its own line empty by
    // design and is kept alive by its target, which is why the target is tested
    // against the resolved versions rather than against a major-line proxy.
    //
    // A flagged entry is dead weight, not necessarily harmless: it would still
    // rewrite a future edge that landed in its selector. Failing forces the
    // choice — re-cut it against the versions actually in the graph, or prune
    // it — rather than leaving a constraint nobody has read since it was cut.
    const lines = override.range === null ? null : selectorLines(override.range)
    const lineLive =
      lines === null || versions.some((version) => lines.some((line) => sameLine(version, line)))
    const targetLive = versions.some((version) => satisfies(version, override.replacement))
    if (!lineLive && !targetLive) {
      findings.push({ kind: 'INERT', override, versions })
    }
  }
  return findings
}

function selfTest() {
  const cases = [
    ['3.15.0', '<3.15.1', true],
    ['3.15.1', '<3.15.1', false],
    ['9.0.0', '<=9.0.0', true],
    ['4.2.0', '>=4.0.0 <4.3.1', true],
    ['4.3.1', '>=4.0.0 <4.3.1', false],
    ['3.15.1', '^3.15.1', true],
    ['3.16.0', '^3.15.1', true],
    ['4.0.0', '^3.15.1', false],
    ['0.28.1', '^0.28.1', true],
    ['0.29.0', '^0.28.1', false],
    ['10.3.1', '10.3.1', true],
  ]
  for (const [version, range, expected] of cases) {
    if (satisfies(version, range) !== expected) {
      throw new Error(`self-test: ${version} vs ${range} should be ${expected}`)
    }
  }

  if (parseSelector('@hono/node-server@<1.19.15').name !== '@hono/node-server') {
    throw new Error('self-test: scoped selector name mis-parsed')
  }
  if (parseSelector('nanoid').range !== null) {
    throw new Error('self-test: bare selector should carry no range')
  }

  const overrides = parseOverrides("overrides:\n  js-yaml@<3.15.1: ^3.15.1\n  'a@<1.0.0': ^1.0.0\n")
  if (overrides.length !== 2 || overrides[1].name !== 'a') {
    throw new Error('self-test: overrides block mis-parsed')
  }

  // A compound `>=A <B` selector must survive parsing; only a genuine
  // parent>child selector is skipped. Conflating the two silently drops the
  // widest overrides in the block from the audit.
  const compound = parseOverrides(
    'overrides:\n  js-yaml@>=4.0.0 <4.3.1: ^4.3.1\n  pkg@>1.0.0: ^2.0.0\n  qar@1>zoo: ^2.0.0\n',
  )
  if (compound.length !== 2) {
    throw new Error('self-test: comparator selectors must not be skipped as parent-scoped')
  }
  if (compound[0].range !== '>=4.0.0 <4.3.1') {
    throw new Error('self-test: compound selector range mis-parsed')
  }
  if (compound[1].range !== '>1.0.0') {
    throw new Error('self-test: strict greater-than selector mis-parsed')
  }

  // A prerelease resolution of an overridden package must fail loudly, never
  // vanish into an ORPHANED or a silently-clean result.
  const prerelease = parseResolvedVersions('packages:\n\n  tagged@1.2.3-rc.1:\n')
  if (prerelease.get('tagged')?.[0] !== '1.2.3-rc.1') {
    throw new Error('self-test: prerelease resolution should be retained, not filtered')
  }
  let threw = false
  try {
    findStaleOverrides(
      [{ name: 'tagged', range: '<2.0.0', replacement: '^2.0.0', key: 'tagged@<2.0.0' }],
      prerelease,
    )
  } catch {
    threw = true
  }
  if (!threw) {
    throw new Error('self-test: prerelease resolution of an overridden package must throw')
  }

  const resolved = parseResolvedVersions("packages:\n\n  js-yaml@3.15.0:\n  '@scope/pkg@1.2.3':\n")
  if (resolved.get('js-yaml')?.[0] !== '3.15.0' || !resolved.has('@scope/pkg')) {
    throw new Error('self-test: lockfile packages mis-parsed')
  }

  const findings = findStaleOverrides(
    [
      { name: 'js-yaml', range: '<3.15.1', replacement: '^3.15.1', key: 'js-yaml@<3.15.1' },
      { name: 'gone', range: '<1.0.0', replacement: '^1.0.0', key: 'gone@<1.0.0' },
    ],
    resolved,
  )
  if (findings.length !== 2) {
    throw new Error('self-test: expected a NOT APPLIED and an ORPHANED finding')
  }
  if (findings[0].kind !== 'NOT APPLIED' || findings[1].kind !== 'ORPHANED') {
    throw new Error('self-test: findings mis-classified')
  }

  // 0.x lines bucket by MINOR: 0.28.1 and 0.28.5 share a line, 0.29.0 does not.
  if (versionLine('0.28.1').join('.') !== '0.28' || versionLine('4.3.1').join('.') !== '4') {
    throw new Error('self-test: version line mis-computed')
  }
  if (!sameLine('0.28.5', [0, 28]) || sameLine('0.29.0', [0, 28])) {
    throw new Error('self-test: 0.x line must bucket by minor, not major')
  }
  if (!sameLine('4.9.9', [4]) || sameLine('5.0.0', [4])) {
    throw new Error('self-test: non-zero line must bucket by major')
  }
  if (
    selectorLines('>=0.27.3 <0.28.1')
      .map((line) => line.join('.'))
      .join(',') !== '0.27,0.28'
  ) {
    throw new Error('self-test: compound selector should span both 0.x lines')
  }

  const twoMajors = new Map([['js-yaml', ['3.15.1', '4.3.1']]])

  // INERT fires: nothing resolves in the 5.x line and the 5.x target landed nowhere.
  const inert = findStaleOverrides(
    [
      {
        name: 'js-yaml',
        range: '>=5.0.0 <5.2.4',
        replacement: '^5.2.4',
        key: 'js-yaml@>=5.0.0 <5.2.4',
      },
    ],
    twoMajors,
  )
  if (inert.length !== 1 || inert[0].kind !== 'INERT') {
    throw new Error('self-test: a dead cross-major entry should be INERT')
  }

  // Cross-major guard: same empty 5.x line, but the 4.x target IS resolved, so
  // the rewrite is live and must not be flagged.
  const crossMajor = findStaleOverrides(
    [
      {
        name: 'js-yaml',
        range: '>=5.0.0 <5.2.4',
        replacement: '^4.3.1',
        key: 'js-yaml@>=5.0.0 <5.2.4',
      },
    ],
    twoMajors,
  )
  if (crossMajor.length !== 0) {
    throw new Error('self-test: a live cross-major rewrite must not be flagged INERT')
  }

  // A 0.x entry whose line is empty and whose target landed nowhere is INERT —
  // the case a major-line proxy would silently pass.
  const zeroX = findStaleOverrides(
    [
      {
        name: 'esbuild',
        range: '>=0.30.0 <0.31.0',
        replacement: '^0.31.0',
        key: 'esbuild@>=0.30.0 <0.31.0',
      },
    ],
    new Map([['esbuild', ['0.25.12', '0.28.1']]]),
  )
  if (zeroX.length !== 1 || zeroX[0].kind !== 'INERT') {
    throw new Error('self-test: dead 0.x entry should be INERT despite live 0.x neighbours')
  }

  process.stdout.write('override-freshness self-test: OK\n')
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }

  const overrides = parseOverrides(readFileSync(WORKSPACE_FILE, 'utf8'))
  const resolved = parseResolvedVersions(readFileSync(LOCKFILE, 'utf8'))
  const findings = findStaleOverrides(overrides, resolved)

  if (findings.length > 0) {
    process.stderr.write('ERROR: stale dependency overrides in pnpm-workspace.yaml:\n')
    for (const { kind, override, versions } of findings) {
      let detail
      if (kind === 'ORPHANED') {
        detail = 'package is absent from the lockfile — prune the entry'
      } else if (kind === 'INERT') {
        detail = `neither the selector's line nor the target reaches ${versions.join(', ')} — re-cut or prune`
      } else {
        detail = `still resolved at ${versions.join(', ')} — the override did not move the graph`
      }
      process.stderr.write(`  ${kind}: ${override.key}: ${override.replacement} — ${detail}\n`)
    }
    process.stderr.write(
      'Re-cut the selector against the versions actually in the graph, or remove it if the package is gone.\n',
    )
    process.exitCode = 1
    return
  }

  process.stdout.write(
    `override-freshness: OK (${overrides.length} overrides; all reach a resolved version)\n`,
  )
}

main()
