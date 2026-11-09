import { instantToLocalParts, localDateTimeToInstant } from '@tali/domain'

/**
 * Instant helpers for the Capture review cards (ticket #101).
 *
 * A draft field that holds a UTC instant is edited on the card as a local
 * `date` + `HH:mm` pair. Both directions can throw: `Temporal` rejects a bare
 * clock time, and a model-supplied draft is not schema-checked for instant
 * syntax. The review screen must render a malformed draft instead of crashing
 * the whole application, so these helpers return `undefined` instead of
 * throwing.
 */

/** The local date/time of an instant, or `undefined` when it is malformed. */
export const instantPartsOf = (
  instant: string,
  timeZone: string,
): { readonly date: string; readonly time: string } | undefined => {
  try {
    return instantToLocalParts(instant, timeZone)
  } catch {
    return undefined
  }
}

/** A full timestamp; a bare `HH:mm` from a Needs Input picker is not one. */
const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

export const isInstant = (value: string): boolean => INSTANT_PATTERN.test(value)

/** A bare clock time, the value a `time` picker reports. */
export const isClockTime = (value: string): boolean => /^\d{1,2}:\d{2}$/.test(value)

/** A local date + clock time as a UTC instant, or `undefined` when invalid. */
export const instantOf = (
  localDate: string,
  clockTime: string,
  timeZone: string,
): string | undefined => {
  try {
    return localDateTimeToInstant(localDate, clockTime, timeZone)
  } catch {
    return undefined
  }
}
