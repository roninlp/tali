import fc from 'fast-check'
import { Temporal } from 'temporal-polyfill/full'
import type { RecurrenceRule } from './recurrence.js'

/**
 * Shared input generators and the seed policy for the property suites
 * (ticket #118).
 *
 * Test-only support code: the `*.property.test.ts` files import from here so
 * the event-recurrence laws reuse the exact same `RecurrenceRule` generator
 * as the engine laws, and so the fixed seed lives in exactly one place.
 * Nothing outside the property suites imports this module.
 */

/**
 * Fixed seed (the ticket number): every CI run replays the same generated
 * cases, so a failure is reproducible from the reported shrunken
 * counterexample. Run counts are set per law; shrinking uses fast-check's
 * defaults and stops at a minimal case.
 */
export const SEED = 118

/**
 * Day zero of the generated date range. Offsets up to ~1600 days cover Jalali
 * years 1404–1409, including the Esfand 30 of the leap year 1408, so the
 * month/year laws exercise the leap-day skip.
 */
const EPOCH = Temporal.PlainDate.from('2026-01-01')

export const isoDate = (offset: number): string =>
  EPOCH.add({ days: offset }).toString()

/** Drop the optional fields the generators left as explicit `undefined`. */
export const compact = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T

const arbInterval = fc.integer({ min: 1, max: 3 })

const arbByDay = fc.option(
  fc.uniqueArray(fc.integer({ min: 1, max: 7 }), {
    minLength: 1,
    maxLength: 7,
  }),
  { nil: undefined },
)

const arbByMonthDay = fc.option(
  fc.uniqueArray(fc.integer({ min: 1, max: 31 }), {
    minLength: 1,
    maxLength: 3,
  }),
  { nil: undefined },
)

const arbNthWeekday = fc.option(
  fc.record({
    nth: fc.oneof(fc.constant(-1), fc.integer({ min: 1, max: 5 })),
    day: fc.integer({ min: 1, max: 7 }),
  }),
  { nil: undefined },
)

/**
 * The monthly/yearly day selector: `byMonthDay`, `nthWeekday`, or neither (the
 * anchor's own day of month). The schema rejects having both at once.
 */
const arbMonthSelector: fc.Arbitrary<{
  byMonthDay: ReadonlyArray<number> | undefined
  nthWeekday: { readonly nth: number; readonly day: number } | undefined
}> = fc.oneof(
  arbByMonthDay.map(byMonthDay => ({ byMonthDay, nthWeekday: undefined })),
  arbNthWeekday.map(nthWeekday => ({ byMonthDay: undefined, nthWeekday })),
  fc.constant({ byMonthDay: undefined, nthWeekday: undefined }),
)

const arbEnd = fc.oneof(
  fc.constant({ _tag: 'never' } as const),
  fc
    .integer({ min: 1, max: 40 })
    .map(count => ({ _tag: 'count' as const, count })),
  fc
    .integer({ min: 0, max: 1600 })
    .map(offset => ({ _tag: 'until' as const, date: isoDate(offset) })),
)

/**
 * A schema-valid rule for every frequency, selector and end the engine
 * documents: daily, weekly (with/without `byDay`), monthly and yearly (with
 * `byMonthDay`, `nthWeekday`, or the anchor's own day), ending never, after a
 * count, or at an inclusive date. Intervals stay small so expansions stay
 * fast.
 */
export const arbRule: fc.Arbitrary<RecurrenceRule> = fc
  .oneof(
    fc.constant('daily' as const),
    fc.constant('weekly' as const),
    fc.constant('monthly' as const),
    fc.constant('yearly' as const),
  )
  .chain((frequency): fc.Arbitrary<RecurrenceRule> => {
    if (frequency === 'daily')
      return fc
        .record({ interval: arbInterval, end: arbEnd })
        .map(({ interval, end }) => ({ frequency, interval, end }))
    if (frequency === 'weekly')
      return fc
        .record({ interval: arbInterval, end: arbEnd, byDay: arbByDay })
        .map(({ interval, end, byDay }) =>
          compact({ frequency, interval, end, byDay }),
        )
    return arbMonthSelector.chain(({ byMonthDay, nthWeekday }) =>
      fc
        .record({ interval: arbInterval, end: arbEnd })
        .map(({ interval, end }) =>
          compact({ frequency, interval, end, byMonthDay, nthWeekday }),
        ),
    )
  })
