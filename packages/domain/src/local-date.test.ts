import { describe, expect, it } from 'vite-plus/test'
import {
  addLocalDays,
  isReadableLocalDate,
  localDateOfInstant,
  localDateOfInstantOption,
  plainDateOf,
} from './local-date.js'

/**
 * The shared local-date helpers. The point of these tests is the failure
 * boundary (throw vs `null`) and calendar safety: the arithmetic must not drift
 * on a DST day, a month end or a year end.
 */
describe('local-date', () => {
  describe('localDateOfInstant', () => {
    it('reads the wall date of an instant in a zone', () => {
      expect(
        localDateOfInstant('2026-10-20T21:30:00.000Z', 'Asia/Tehran'),
      ).toBe('2026-10-21')
      expect(localDateOfInstant('2026-10-20T21:30:00.000Z', 'UTC')).toBe(
        '2026-10-20',
      )
    })

    it('throws on a malformed instant or zone (trusted inputs)', () => {
      expect(() => localDateOfInstant('not-an-instant', 'UTC')).toThrow()
      expect(() =>
        localDateOfInstant('2026-10-20T21:30:00.000Z', 'Mars/Olympus'),
      ).toThrow()
    })

    it('keeps the local date across a DST spring-forward', () => {
      // America/New_York jumps 02:00 → 03:00 on 2026-03-08.
      expect(
        localDateOfInstant('2026-03-08T06:59:00.000Z', 'America/New_York'),
      ).toBe('2026-03-08')
      expect(
        localDateOfInstant('2026-03-08T04:59:00.000Z', 'America/New_York'),
      ).toBe('2026-03-07')
    })

    it('keeps the local date across a DST fall-back', () => {
      // 2026-11-01 02:00 EDT falls back to 01:00 EST; the wall date is 11-01.
      expect(
        localDateOfInstant('2026-11-01T05:30:00.000Z', 'America/New_York'),
      ).toBe('2026-11-01')
      expect(
        localDateOfInstant('2026-11-01T04:30:00.000Z', 'America/New_York'),
      ).toBe('2026-11-01')
    })
  })

  describe('localDateOfInstantOption', () => {
    it('returns the date when the input is usable', () => {
      expect(localDateOfInstantOption('2026-10-20T21:30:00.000Z', 'UTC')).toBe(
        '2026-10-20',
      )
    })

    it('returns null instead of throwing (the sync path must not throw)', () => {
      expect(localDateOfInstantOption('not-an-instant', 'UTC')).toBeNull()
      expect(
        localDateOfInstantOption('2026-10-20T21:30:00.000Z', 'Mars/Olympus'),
      ).toBeNull()
    })
  })

  describe('addLocalDays', () => {
    it('shifts one day within a month', () => {
      expect(addLocalDays('2026-11-10', 1)).toBe('2026-11-11')
      expect(addLocalDays('2026-11-10', -1)).toBe('2026-11-09')
    })

    it('crosses a month boundary', () => {
      expect(addLocalDays('2026-01-31', 1)).toBe('2026-02-01')
      expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28')
    })

    it('crosses a year boundary', () => {
      expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01')
      expect(addLocalDays('2027-01-01', -1)).toBe('2026-12-31')
    })

    it('handles a leap day', () => {
      expect(addLocalDays('2028-02-28', 1)).toBe('2028-02-29')
      expect(addLocalDays('2028-02-29', 1)).toBe('2028-03-01')
    })

    it('counts whole calendar days over a year and a DST boundary', () => {
      expect(addLocalDays('2026-01-01', 365)).toBe('2027-01-01')
      // 2026-03-08 is a spring-forward day in America/New_York; a calendar-day
      // shift must still land on the next date.
      expect(addLocalDays('2026-03-07', 1)).toBe('2026-03-08')
      expect(addLocalDays('2026-03-08', 1)).toBe('2026-03-09')
    })

    it('throws on an unreadable date rather than guessing', () => {
      expect(() => addLocalDays('2026-02-30', 1)).toThrow()
      expect(() => addLocalDays('nope', 1)).toThrow()
    })
  })

  describe('isReadableLocalDate', () => {
    it('accepts a real calendar date', () => {
      expect(isReadableLocalDate('2026-11-11')).toBe(true)
      expect(isReadableLocalDate('2028-02-29')).toBe(true)
    })

    it('rejects a date the calendar cannot read', () => {
      expect(isReadableLocalDate('2026-02-30')).toBe(false)
      expect(isReadableLocalDate('2026-13-01')).toBe(false)
      expect(isReadableLocalDate('11/11/2026')).toBe(false)
      expect(isReadableLocalDate('')).toBe(false)
    })
  })

  describe('plainDateOf', () => {
    it('parses a stored local date', () => {
      expect(plainDateOf('2026-11-11').toString()).toBe('2026-11-11')
    })

    it('throws on a malformed value', () => {
      expect(() => plainDateOf('2026-02-30')).toThrow()
    })
  })
})
