import { describe, expect, it } from "vitest"
import {
  DEFAULT_DIGITS,
  formatNumber,
  localizeDigits,
  toLatinDigits,
  toPersianDigits
} from "./digits.js"

describe("digit rendering", () => {
  it("defaults to Persian digits", () => {
    expect(DEFAULT_DIGITS).toBe("persian")
    expect(toPersianDigits("1403-07-15")).toBe("۱۴۰۳-۰۷-۱۵")
    expect(localizeDigits(2026)).toBe("۲۰۲۶")
  })

  it("converts Persian and Arabic-Indic digits back to Latin", () => {
    expect(toLatinDigits("۱۴۰۳/۰۷/۱۵")).toBe("1403/07/15")
    expect(toLatinDigits("١٤٠٣")).toBe("1403")
    expect(localizeDigits("۱۴۰۳", "latin")).toBe("1403")
  })

  it("formats numbers with Persian separators by default", () => {
    expect(formatNumber(1234)).toBe("۱٬۲۳۴")
    expect(formatNumber(1234, { digits: "latin" })).toBe("1,234")
    expect(formatNumber(1.5, { maximumFractionDigits: 2 })).toBe("۱٫۵")
    expect(formatNumber(1.5, { digits: "latin", maximumFractionDigits: 2 })).toBe("1.5")
  })
})
