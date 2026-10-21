import { describe, expect, it } from "vitest"
import {
  buildSearchMatchQuery,
  buildVariantInsensitivePattern,
  normalizePersian,
  splitSearchSegments
} from "./persian"

/**
 * The normalization is the whole point of the ticket: a note written in one
 * spelling has to be found by the other, so these cases pin the folding table
 * (`docs/research/d1-persian-fts.md` §3).
 */
describe("normalizePersian", () => {
  it("folds the Arabic spellings onto the Farsi ones", () => {
    expect(normalizePersian("ميروم")).toBe("میروم")
    expect(normalizePersian("كتاب")).toBe("کتاب")
    expect(normalizePersian("مدرسة")).toBe("مدرسه")
  })

  it("folds the hamza carriers onto their bare letters", () => {
    expect(normalizePersian("أحمد")).toBe("احمد")
    expect(normalizePersian("إسلام")).toBe("اسلام")
    expect(normalizePersian("آب")).toBe("اب")
    expect(normalizePersian("مسؤول")).toBe("مسوول")
    // A yeh with hamza folds to the plain yeh (hazm's rule), so this is a
    // different word from `مسؤول`, not another spelling of it.
    expect(normalizePersian("مسئول")).toBe("مسیول")
  })

  it("removes the half-space so a compound is one token", () => {
    expect(normalizePersian("می‌روم")).toBe("میروم")
    expect(normalizePersian("می‌روم")).toBe(normalizePersian("میروم"))
  })

  it("keeps a real space a word boundary", () => {
    expect(normalizePersian("می روم")).toBe("می روم")
  })

  it("strips the harakat, which unicode61 would split on", () => {
    expect(normalizePersian("مُحَمَّد")).toBe("محمد")
    expect(normalizePersian("کتابٌ")).toBe("کتاب")
  })

  it("drops the tatweel and the standalone hamza", () => {
    expect(normalizePersian("کـــتاب")).toBe("کتاب")
    expect(normalizePersian("ء")).toBe("")
  })

  it("turns the Arabic-Indic digits into ASCII ones", () => {
    expect(normalizePersian("قیمت ۱۲۰")).toBe("قیمت 120")
    expect(normalizePersian("قیمت ١٢٠")).toBe("قیمت 120")
  })

  it("folds the Arabic presentation forms", () => {
    expect(normalizePersian("ﻣﻴﺮوم")).toBe("میروم")
  })

  it("is idempotent", () => {
    const once = normalizePersian("مُحَمَّد می‌رود و کتاب می‌خواند ۱۲۰")
    expect(normalizePersian(once)).toBe(once)
  })

  it("collapses whitespace", () => {
    expect(normalizePersian("  دو   کلمه \n")).toBe("دو کلمه")
  })
})

describe("buildSearchMatchQuery", () => {
  it("quotes every token so a query is never FTS5 syntax", () => {
    expect(buildSearchMatchQuery("دارو")).toBe('"دارو"*')
    expect(buildSearchMatchQuery('a "b')).toBe('"a" """b"*')
  })

  it("prefixes only the last token", () => {
    expect(buildSearchMatchQuery("دارو خانه")).toBe('"دارو" "خانه"*')
  })

  it("folds the query before building it", () => {
    expect(buildSearchMatchQuery("ميروم")).toBe('"میروم"*')
    expect(buildSearchMatchQuery("می‌روم")).toBe('"میروم"*')
  })

  it("has no query for an empty or punctuation-only search", () => {
    expect(buildSearchMatchQuery("")).toBeUndefined()
    expect(buildSearchMatchQuery("   ")).toBeUndefined()
    expect(buildSearchMatchQuery("---")).toBeUndefined()
  })
})

describe("splitSearchSegments", () => {
  it("splits the marked string into plain and matched runs", () => {
    expect(splitSearchSegments("سلام \u0001دارو\u0002 امروز")).toEqual([
      { text: "سلام ", match: false },
      { text: "دارو", match: true },
      { text: " امروز", match: false }
    ])
  })

  it("keeps a leading match", () => {
    expect(splitSearchSegments("\u0001دارو\u0002")).toEqual([
      { text: "دارو", match: true }
    ])
  })

  it("returns nothing for an empty string", () => {
    expect(splitSearchSegments("")).toEqual([])
  })
})

describe("buildVariantInsensitivePattern", () => {
  it("matches the Arabic spelling of a Farsi query", () => {
    const pattern = buildVariantInsensitivePattern("میروم")
    expect(pattern?.test("ميروم")).toBe(true)
    expect(pattern?.test("میروم")).toBe(true)
  })

  it("matches across the half-space", () => {
    const pattern = buildVariantInsensitivePattern("میروم")
    expect(pattern?.test("می‌روم")).toBe(true)
    expect(pattern?.test("می روم")).toBe(true)
  })

  it("matches the kaf and heh variants", () => {
    expect(buildVariantInsensitivePattern("کتاب")?.test("كتاب")).toBe(true)
    expect(buildVariantInsensitivePattern("مدرسه")?.test("مدرسة")).toBe(true)
  })

  it("has no pattern for a query with nothing searchable", () => {
    expect(buildVariantInsensitivePattern("")).toBeUndefined()
    expect(buildVariantInsensitivePattern("***")).toBeUndefined()
  })
})
