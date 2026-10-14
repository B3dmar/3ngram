// SPDX-License-Identifier: Apache-2.0
// isoDateTime() must accept and reject exactly what zod 4.4.3's
// z.iso.datetime() did. REFERENCE below is zod 4.4.3's regexes.datetime,
// copied verbatim from zod@4.4.3/v4/core/regexes.js (dateSource, timeSource,
// datetime) so the comparison does not lean on the helper's own builder. The
// default-options column and the issue shape are pinned to what zod 4.4.3
// itself produced for these inputs (captured from the 4.4.3 package).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type IsoDateTimeOptions, isoDateTime } from '../src/iso-datetime.js'

const dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`
function timeSource(args: { precision?: number | null }): string {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`
  const regex =
    typeof args.precision === 'number'
      ? args.precision === -1
        ? `${hhmm}`
        : args.precision === 0
          ? `${hhmm}:[0-5]\\d`
          : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}`
      : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`
  return regex
}
function REFERENCE(args: { precision?: number | null; offset?: boolean; local?: boolean }): RegExp {
  const time = timeSource({ precision: args.precision ?? null })
  const opts = ['Z']
  if (args.local) opts.push('')
  if (args.offset) opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`)
  const timeRegex = `${time}(?:${opts.join('|')})`
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`)
}

// [input, zod 4.4.3 z.iso.datetime() with default options accepted it]
const CASES: ReadonlyArray<readonly [string, boolean]> = [
  ['2026-01-01T06:15Z', true], // minute precision with Z (zod >=4.5 rejects)
  ['2026-01-01T06:15+02:00', false], // minute precision with an offset
  ['2026-01-01T06:15:00Z', true], // seconds
  ['2026-01-01T06:15:00.1Z', true], // one fractional digit
  ['2026-01-01T06:15:00.123Z', true], // milliseconds
  ['2026-01-01T06:15:00.123456789Z', true], // 9 fractional digits
  ['2026-01-01T06:15:00.1234567891Z', true], // 10 fractional digits
  ['2026-01-01T06:15:00+02:00', false], // offset (needs offset: true)
  ['2026-01-01T06:15:00.123-05:30', false], // fraction + negative offset
  ['2026-01-01 06:15:00Z', false], // space instead of T
  ['2026-01-0106:15:00Z', false], // missing T
  ['2026-01-01T24:00:00Z', false], // 24:00
  ['2026-01-01T24:00Z', false], // 24:00, minute precision
  ['2026-01-01T06:15:00+24:00', false], // out-of-range offset
  ['2026-01-01T06:15:00+0200', false], // offset without a colon
  ['2026-01-01T06:15:00z', false], // lowercase z
  ['2026-01-01t06:15:00Z', false], // lowercase t
  ['2026-01-01T06:15:00', false], // local, seconds (needs local: true)
  ['2026-01-01T06:15', false], // local, minutes (needs local: true)
  ['2026-02-29T00:00:00Z', false], // not a leap year
  ['2024-02-29T00:00:00Z', true], // leap day
  ['2026-13-01T00:00:00Z', false], // month 13
  ['2026-01-01T06:60:00Z', false], // minute 60
  ['2026-01-01T06:15:00.Z', false], // empty fraction
  ['2026-01-01T06Z', false], // hour only
  ['', false],
]

const OPTION_SETS: ReadonlyArray<IsoDateTimeOptions> = [
  {},
  { precision: null }, // zod's TimePrecision.Any: same grammar as omitted
  { offset: true },
  { local: true },
  { offset: true, local: true },
  { precision: -1 },
  { precision: 0 },
  { precision: 3 },
  { precision: 3, offset: true },
]

describe('isoDateTime() keeps the zod 4.4.3 datetime grammar', () => {
  it('matches the pinned zod 4.4.3 verdict for every input (default options)', () => {
    for (const [input, accepted] of CASES) {
      expect({ input, accepted: isoDateTime().safeParse(input).success }).toEqual({
        input,
        accepted,
      })
    }
  })

  for (const options of OPTION_SETS) {
    it(`matches the zod 4.4.3 regex for ${JSON.stringify(options)}`, () => {
      const reference = REFERENCE(options)
      const schema = isoDateTime(options)
      for (const [input] of CASES) {
        expect({ input, accepted: schema.safeParse(input).success }).toEqual({
          input,
          accepted: reference.test(input),
        })
      }
    })
  }

  it('reports the zod 4.4.3 issue for an invalid input', () => {
    // zod 4.4.3 reported exactly this object (no `input`: reportInput is off).
    const result = isoDateTime().safeParse('2026-01-01 06:15:00Z')
    expect(result.success).toBe(false)
    expect(result.error?.issues).toEqual([
      {
        origin: 'string',
        code: 'invalid_format',
        format: 'datetime',
        pattern: REFERENCE({}).toString(),
        path: [],
        message: 'Invalid ISO datetime',
      },
    ])
  })

  it('emits the zod 4.4.3 JSON Schema: format date-time plus the 4.4.3 pattern', () => {
    for (const options of [{}, { offset: true }] satisfies IsoDateTimeOptions[]) {
      expect(z.toJSONSchema(isoDateTime(options))).toEqual({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'string',
        format: 'date-time',
        pattern: REFERENCE(options).source,
      })
    }
  })

  it('keeps the grammar when composed into an object, nullable or refined', () => {
    const wrapped = z.object({
      at: isoDateTime(),
      until: isoDateTime().nullable(),
      checked: isoDateTime().refine(() => true),
    })
    const minute = '2026-01-01T06:15Z'
    expect(wrapped.safeParse({ at: minute, until: minute, checked: minute }).success).toBe(true)
    expect(
      wrapped.safeParse({ at: minute, until: null, checked: '2026-01-01T06:15' }).success,
    ).toBe(false)
  })
})
