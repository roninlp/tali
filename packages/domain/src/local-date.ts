import { Temporal } from 'temporal-polyfill/full'
import type { LocalDate } from './planning/common.js'

/**
 * Local calendar-date arithmetic on `Temporal`, in one place.
 *
 * Every aggregate that projects an instant onto a wall date — habits, events,
 * occasions, tasks, buckets, reminders, capture — needs the same three moves:
 *
 * - `Instant` → local `PlainDate` in an IANA zone (the owner's wall date, never
 *   the UTC one);
 * - `PlainDate` → `YYYY-MM-DD` text (`LocalDate`);
 * - whole-day shifting, which must stay calendar-safe across month, year and
 *   DST boundaries (`PlainDate.add` is, `Date` arithmetic is not).
 *
 * ## Failure policy stays with the caller
 *
 * The helpers expose the two policies the codebase actually uses rather than
 * choosing one: {@link localDateOfInstant} throws on an unusable instant/zone
 * (trusted, server-derived inputs), and {@link localDateOfInstantOption}
 * returns `null` for the sync/merge paths that receive client patches and must
 * never turn a bad field into a retryable 500. Callers keep whichever policy
 * they had; only the arithmetic is shared.
 *
 * Dates are plain ISO calendar dates here. The Jalali projections in
 * `jalali.ts` convert for display; they are a separate calendar and do not go
 * through these helpers.
 */

/** Parse a stored local date, or throw (trusted inputs). */
export const plainDateOf = (value: string): Temporal.PlainDate =>
  Temporal.PlainDate.from(value)

/** Local calendar date (`YYYY-MM-DD`) of an instant in a zone. Throws on bad input. */
export const localDateOfInstant = (
  instant: string,
  timeZone: string,
): LocalDate =>
  Temporal.Instant.from(instant)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString() as LocalDate

/** As above, but malformed input yields null (the sync path must never throw). */
export const localDateOfInstantOption = (
  instant: string,
  timeZone: string,
): LocalDate | null => {
  try {
    return localDateOfInstant(instant, timeZone)
  } catch {
    return null
  }
}

/** Shift a local date by whole days (calendar-safe). */
export const addLocalDays = (date: string, days: number): LocalDate =>
  plainDateOf(date).add({ days }).toString() as LocalDate

/** True when the value parses as a real calendar date (`2026-02-30` is not). */
export const isReadableLocalDate = (value: string): boolean => {
  try {
    plainDateOf(value)
    return true
  } catch {
    return false
  }
}
