import { describe, expect, it } from "vitest"
import { markMatches, searchNotesLocally } from "./search"
import type { NoteRow } from "./mirror"

/**
 * Ticket #41 web logic: the offline search.
 *
 * The server's FTS5 index is the primary search; when the network is gone the
 * local mirror answers instead, with the same variant-insensitive matching —
 * so a query finds the same notes offline and online.
 */

const row = (overrides: Partial<NoteRow> & { readonly id: string }): NoteRow => ({
  data: {},
  version: 1,
  updatedAt: "2026-10-20T09:30:00.000Z",
  deletedAt: null,
  isPinned: false,
  isArchived: false,
  tagIds: [],
  title: "",
  text: "",
  excerpt: "",
  ...overrides
})

describe("markMatches", () => {
  it("splits the text into plain and matched runs", () => {
    const pattern = /دارو/gu
    expect(markMatches("قرص دارو می‌خورم", pattern)).toEqual([
      { text: "قرص ", match: false },
      { text: "دارو", match: true },
      { text: " می‌خورم", match: false }
    ])
  })

  it("marks every occurrence", () => {
    expect(markMatches("نان و نان", /نان/gu)).toEqual([
      { text: "نان", match: true },
      { text: " و ", match: false },
      { text: "نان", match: true }
    ])
  })

  it("returns the whole text as plain when nothing matches", () => {
    expect(markMatches("نان", /پنیر/gu)).toEqual([{ text: "نان", match: false }])
  })
})

describe("searchNotesLocally", () => {
  const notes: ReadonlyArray<NoteRow> = [
    row({ id: "n-1", title: "خرید دارو", text: "قرص میروم" }),
    row({ id: "n-2", title: "نان", text: "نان و پنیر" }),
    row({ id: "n-3", title: "محرمانه", text: "رمز خانواده", deletedAt: "2026-10-20T10:00:00.000Z" })
  ]

  it("finds a note by another Persian spelling", () => {
    const hits = searchNotesLocally(notes, "میروم")
    expect(hits.map((hit) => hit.id)).toEqual(["n-1"])
  })

  it("finds a note across the half-space", () => {
    const hits = searchNotesLocally(notes, "میروم")
    expect(hits.map((hit) => hit.id)).toEqual(["n-1"])
  })

  it("never returns a trashed note", () => {
    expect(searchNotesLocally(notes, "رمز")).toEqual([])
  })

  it("returns nothing for a query with nothing searchable", () => {
    expect(searchNotesLocally(notes, "")).toEqual([])
    expect(searchNotesLocally(notes, "---")).toEqual([])
  })

  it("marks the match in the snippet", () => {
    const hits = searchNotesLocally(notes, "پنیر")
    expect(hits).toHaveLength(1)
    expect(hits[0]!.segments.some((segment) => segment.match)).toBe(true)
  })
})
