import type { Digits } from "./common.js"

/**
 * Numeral rendering (CC-04).
 *
 * Tali shows Persian digits by default. The choice is a presentation concern
 * only: values stay plain JavaScript numbers (and ISO strings) in the domain,
 * mirror and wire. Callers pass `{ digits: "latin" }` for the opt-out.
 */

export const DEFAULT_DIGITS: Digits = "persian"

const PERSIAN_ZERO = 0x06f0
const ARABIC_ZERO = 0x0660

const persianDigit = (digit: number): string =>
  String.fromCharCode(PERSIAN_ZERO + digit)

/** Render the ASCII digits in a string with Persian (Extended Arabic-Indic) digits. */
export const toPersianDigits = (value: string | number): string =>
  String(value).replace(/[0-9]/g, (digit) => persianDigit(Number(digit)))

/** Render Persian/Arabic-Indic digits in a string as ASCII digits. */
export const toLatinDigits = (value: string | number): string =>
  String(value).replace(/[۰-۹٠-٩]/g, (digit) => {
    const code = digit.charCodeAt(0)
    const digitValue = code >= PERSIAN_ZERO ? code - PERSIAN_ZERO : code - ARABIC_ZERO
    return String(digitValue)
  })

/**
 * Localize the digits in an already-formatted string (ids, dates, labels).
 * Defaults to Persian; `digits: "latin"` converts Persian input back to ASCII.
 */
export const localizeDigits = (
  value: string | number,
  digits: Digits = DEFAULT_DIGITS
): string => (digits === "persian" ? toPersianDigits(value) : toLatinDigits(value))

export interface FormatNumberOptions {
  /** `persian` (default) or the Latin opt-out. */
  readonly digits?: Digits
  readonly useGrouping?: boolean
  readonly minimumFractionDigits?: number
  readonly maximumFractionDigits?: number
}

/**
 * Format a number for display. Persian digits and Persian separators are the
 * default; `digits: "latin"` uses ASCII digits with Latin separators.
 */
export const formatNumber = (value: number, options: FormatNumberOptions = {}): string => {
  const { digits = DEFAULT_DIGITS, ...numberFormat } = options
  return new Intl.NumberFormat(digits === "persian" ? "fa-IR-u-nu-arabext" : "fa-IR-u-nu-latn", {
    useGrouping: numberFormat.useGrouping,
    minimumFractionDigits: numberFormat.minimumFractionDigits,
    maximumFractionDigits: numberFormat.maximumFractionDigits
  }).format(value)
}
