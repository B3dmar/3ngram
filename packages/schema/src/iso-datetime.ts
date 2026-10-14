// SPDX-License-Identifier: Apache-2.0
// The ONE ISO 8601 datetime grammar for every schema in this package.
//
// zod 4.5 tightened `z.iso.datetime()` to RFC 3339: once a time carries `Z` or
// an offset it must include seconds, so `2026-01-01T06:15Z` stopped parsing.
// The tightening is upstream's correctness call, not ours, and adopting it
// would reject input every 3ngram transport accepted under zod 4.4.3 (search
// `validAt`/`asKnownAt`, recorded and valid-time ranges, fact timestamps),
// making a dependency bump a client-visible contract change. So the grammar
// stays the zod 4.4.3 one, pinned here, until a deliberate contract change
// moves it.
//
// Mechanism: zod's `$ZodISODateTime` only computes its pattern when the def
// does not carry one (`def.pattern ??= regexes.datetime(def)`), and the
// runtime check, the compiled fast path and the JSON Schema emitter all read
// `def.pattern`. Supplying the 4.4.3 pattern therefore keeps the schema a real
// `ZodISODateTime`: same `invalid_format`/`datetime` issue and message, same
// `format: date-time` plus the 4.4.3 `pattern` in emitted JSON Schema. A union
// or refinement would instead change the issue shape and the advertised
// schema. `z.iso.datetime()`'s params type omits `pattern`, so the schema is
// built through the class constructor that `z.iso.datetime()` itself calls.
//
// On every zod bump, re-run test/iso-datetime.test.ts: it pins the behaviour
// and the emitted pattern, so a zod release that stops honouring a supplied
// `def.pattern` fails there first.
import { z } from 'zod'

/** Grammar options; the same three `z.iso.datetime()` takes, with the same defaults. */
export interface IsoDateTimeOptions {
  /** Also accept a numeric UTC offset such as `+02:00` in place of `Z`. Default `false`. */
  readonly offset?: boolean
  /** Also accept a time with neither `Z` nor an offset. Default `false`. */
  readonly local?: boolean
  /**
   * Fixed time precision: `-1` minutes only, `0` whole seconds, `n > 0` exactly
   * `n` fractional digits. Omitted, seconds and any number of fractional digits
   * are optional.
   */
  readonly precision?: number
}

// zod 4.4.3 `dateSource`, verbatim: calendar-valid dates including leap days.
const DATE_SOURCE =
  '(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))'

// zod 4.4.3 `timeSource`: with no precision, seconds stay optional even before `Z`.
function timeSource(precision: number | undefined): string {
  const hhmm = '(?:[01]\\d|2[0-3]):[0-5]\\d'
  if (precision === undefined) return `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`
  if (precision === -1) return hhmm
  if (precision === 0) return `${hhmm}:[0-5]\\d`
  return `${hhmm}:[0-5]\\d\\.\\d{${precision}}`
}

// zod 4.4.3 `regexes.datetime`, including the order of the zone alternatives,
// so the emitted JSON Schema `pattern` is byte-identical to the pre-4.5 one.
function dateTimePattern(options: IsoDateTimeOptions): RegExp {
  const zones = ['Z']
  if (options.local) zones.push('')
  if (options.offset) zones.push('([+-](?:[01]\\d|2[0-3]):[0-5]\\d)')
  const time = `${timeSource(options.precision)}(?:${zones.join('|')})`
  return new RegExp(`^${DATE_SOURCE}T(?:${time})$`)
}

/**
 * An ISO 8601 datetime string schema that accepts and rejects exactly what
 * zod 4.4.3's `z.iso.datetime(options)` did, minute precision included. Use it
 * for every datetime field, input or output, so the package has one grammar.
 */
export function isoDateTime(options: IsoDateTimeOptions = {}): z.ZodISODateTime {
  return new z.ZodISODateTime({
    type: 'string',
    format: 'datetime',
    check: 'string_format',
    offset: options.offset ?? false,
    local: options.local ?? false,
    precision: options.precision ?? null,
    pattern: dateTimePattern(options),
  })
}
