// SPDX-License-Identifier: Apache-2.0

// Times as the pane shows them: on the wall clock of a zone the caller names,
// so every rule here is specified with a fixed zone (spec/view.spec.ts). The
// render hook names the host's zone as the module runtime reports it
// (hostZone). A zone the runtime cannot use is read as UTC, never guessed, and
// a time shown with its zone names the zone it was drawn in.

export type Clock = { now: number; zone: string }

type Wall = { year: number; month: number; day: number; hour: number; minute: number; zone: string }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 86_400_000
const formats = new Map<string, Intl.DateTimeFormat>()

// en-GB names a European zone by its abbreviation (CET, CEST) and any other by
// its offset (GMT-5), and h23 keeps midnight at 00 rather than 24.
function formatFor(zone: string): Intl.DateTimeFormat {
  let format = formats.get(zone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      timeZoneName: 'short',
    })
    formats.set(zone, format)
  }
  return format
}

// usableZone is zone when the runtime can draw times in it, UTC otherwise.
export function usableZone(zone: unknown): string {
  if (typeof zone !== 'string' || zone === '') return 'UTC'
  try {
    formatFor(zone)
    return zone
  } catch {
    return 'UTC'
  }
}

// hostZone is the zone the module runtime runs in: the host's, which it
// follows like any process (TZ, else the system setting).
export function hostZone(): string {
  return usableZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
}

function wall(ms: number, zone: string): Wall {
  const parts = formatFor(zone).formatToParts(new Date(ms))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? ''
  return {
    year: Number(part('year')),
    month: Number(part('month')),
    day: Number(part('day')),
    hour: Number(part('hour')),
    minute: Number(part('minute')),
    zone: part('timeZoneName'),
  }
}

// dayIndex numbers a wall date, so two of them subtract to the calendar days
// between them, whatever the length of the days in between.
function dayIndex(w: Wall): number {
  return Date.UTC(w.year, w.month - 1, w.day) / DAY_MS
}

function hhmm(w: Wall): string {
  return `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`
}

// date is a wall date as "12 Nov", with its year only when that is not the
// year of today.
function date(w: Wall, today: Wall): string {
  const year = w.year === today.year ? '' : ` ${w.year}`
  return `${w.day} ${MONTHS[w.month - 1] ?? '?'}${year}`
}

// stamp is an instant with its zone: "17:40 CET" on the day it is drawn, with
// its date on any other, so rows read yesterday never pass for today's.
export function stamp(ms: number, clock: Clock): string {
  const w = wall(ms, clock.zone)
  const today = wall(clock.now, clock.zone)
  const day = dayIndex(w) === dayIndex(today) ? '' : `${date(w, today)} `
  return `${day}${hhmm(w)} ${w.zone}`
}

// dayOf is an instant as its date alone ("6 Oct"), for what the pane dates but
// does not time; one that does not parse is shown as it came.
export function dayOf(iso: string, clock: Clock): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso.slice(0, 10)
  return date(wall(ms, clock.zone), wall(clock.now, clock.zone))
}

// nextMidnight is when a view drawn at clock.now goes out of date by the
// clock alone: the first instant of the next day in its zone. It is searched
// for rather than added up, since a day can last 23 or 25 hours and a zone
// whose clocks skip midnight starts that day at 01:00.
export function nextMidnight(clock: Clock): number {
  const today = dayIndex(wall(clock.now, clock.zone))
  let lo = clock.now
  let hi = clock.now + 2 * DAY_MS
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (dayIndex(wall(mid, clock.zone)) === today) lo = mid
    else hi = mid
  }
  return hi
}

// dueLabels reads a deadline against the clock, relative first, in calendar
// days of the clock's zone: "due today 18:00", "due tomorrow 09:30", "due in
// 5 days · 10 Nov 18:00", "overdue since today 09:00", "overdue since
// yesterday 18:00", "3 days overdue · due 2 Nov 18:00". A deadline is an
// instant (packages/schema), and briefing reads it as overdue once it has
// passed: exactly at it, a row is still due. Its time of day is always shown,
// in the zone named once beside it (withZone) or on the status line.
export function dueLabels(dueAt: string | null, clock: Clock, withZone = false): string[] {
  if (dueAt === null) return ['no due date']
  const ms = Date.parse(dueAt)
  if (Number.isNaN(ms)) return [`due date unreadable: ${dueAt}`]
  const due = wall(ms, clock.zone)
  const today = wall(clock.now, clock.zone)
  const days = dayIndex(due) - dayIndex(today)
  const at = withZone ? `${hhmm(due)} ${due.zone}` : hhmm(due)
  const on = `${date(due, today)} ${at}`
  if (ms >= clock.now) {
    if (days <= 0) return [`due today ${at}`]
    if (days === 1) return [`due tomorrow ${at}`]
    return [`due in ${days} days`, on]
  }
  if (days >= 0) return [`overdue since today ${at}`]
  if (days === -1) return [`overdue since yesterday ${at}`]
  return [`${-days} days overdue`, `due ${on}`]
}
