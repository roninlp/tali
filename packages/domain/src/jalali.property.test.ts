import fc from 'fast-check'
import { Temporal } from 'temporal-polyfill/full'
import { describe, expect, it } from 'vite-plus/test'
import { SEED } from './property-helpers.js'
import {
  addJalaliDays,
  daysInJalaliMonth,
  daysInJalaliYear,
  isJalaliLeapYear,
  jalaliDate,
  toIsoDate,
  toJalaliDate,
  toJalaliFields,
} from './jalali.js'

/**
 * Ticket #118 — property laws for the Jalali conversion engine.
 *
 * `jalali.ts` never does date math itself: it projects ISO dates through the
 * `persian` Intl calendar. The laws pin the projections' documented
 * behaviour: conversion round-trips over the supported range, the fields are
 * always in range for the calendar's own month lengths, and a leap year is
 * exactly a year with an Esfand 30.
 */

/** Any ISO date in 1901–2099, reached through the first 28 days plus a drift. */
const arbIsoDate = fc
  .record({
    year: fc.integer({ min: 1901, max: 2099 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
    drift: fc.integer({ min: 0, max: 2 }),
  })
  .map(({ year, month, day, drift }) =>
    Temporal.PlainDate.from({ year, month, day })
      .add({ days: drift })
      .toString(),
  )

describe('Jalali conversion (property laws)', () => {
  it('round-trips ISO → Jalali fields → ISO over the supported range', () => {
    fc.assert(
      fc.property(arbIsoDate, iso => {
        expect(toIsoDate(toJalaliDate(iso))).toBe(iso)
        const fields = toJalaliFields(toJalaliDate(iso))
        // The projected fields name a real Jalali date: month 1–12, a day
        // inside that month's own length.
        expect(fields.month).toBeGreaterThanOrEqual(1)
        expect(fields.month).toBeLessThanOrEqual(12)
        expect(fields.day).toBeGreaterThanOrEqual(1)
        expect(fields.day).toBeLessThanOrEqual(
          daysInJalaliMonth(fields.year, fields.month),
        )
        // … and that date is the ISO date we started from.
        expect(
          toIsoDate(jalaliDate(fields.year, fields.month, fields.day)),
        ).toBe(iso)
      }),
      { seed: SEED, numRuns: 150 },
    )
  })

  it('treats a leap year as exactly a year with an Esfand 30', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1300, max: 1500 }), year => {
        const leap = isJalaliLeapYear(year)
        // Esfand 30 exists in a leap year and only there; a leap year is
        // the one 366-day year.
        expect(daysInJalaliMonth(year, 12)).toBe(leap ? 30 : 29)
        expect(daysInJalaliYear(year)).toBe(leap ? 366 : 365)
      }),
      { seed: SEED, numRuns: 100 },
    )
  })

  it('rolls the day after a month end into the next month', () => {
    fc.assert(
      fc.property(
        fc.record({
          year: fc.integer({ min: 1300, max: 1500 }),
          month: fc.integer({ min: 1, max: 12 }),
        }),
        ({ year, month }) => {
          const last = jalaliDate(year, month, daysInJalaliMonth(year, month))
          const next = addJalaliDays(last, 1)
          expect(next.day).toBe(1)
          expect(next.month).toBe((month % 12) + 1)
          expect(next.year).toBe(month === 12 ? year + 1 : year)
        },
      ),
      { seed: SEED, numRuns: 150 },
    )
  })
})
