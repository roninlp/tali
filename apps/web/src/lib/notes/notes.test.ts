import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import { uuidV7 } from "@tali/domain"
import { openLocalStore } from "../local-store/store"
import {
  noteDisplayTitle,
  noteExcerpt,
  noteTextFromBody,
  noteTextFromData,
  textToNoteBody
} from "./body"
import { noteDraftKey, parseNoteDraft, reconcileDraft, serializeNoteDraft } from "./draft"
import { filterNotesByTags, sortNotes, toNoteRow, createNoteInMirror } from "./mirror"

/**
 * Ticket #40 web logic: the fallback body envelope, draft reconciliation
 * (no clobbering newer server text), list ordering, and the offline quick
 * create path.
 */

describe("note body", () => {
  it("round-trips multiline Persian text through the ProseMirror-shaped doc", () => {
    const text = "نان سنگک\n\nشیر و پنیر"
    const body = textToNoteBody(text)
    expect(noteTextFromBody(body)).toBe(text)
    expect(noteTextFromData({ body, plainText: "ignored" })).toBe(text)
  })

  it("falls back to plainText for a legacy/rich body it cannot read", () => {
    expect(noteTextFromData({ body: null, plainText: "متن ذخیره‌شده" })).toBe("متن ذخیره‌شده")
    expect(noteTextFromBody({ type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "تیتر" }] }] })).toBe(
      "تیتر"
    )
  })

  it("derives a list title and a bounded excerpt", () => {
    expect(noteDisplayTitle({ title: "  ", body: textToNoteBody("خط اول\nخط دوم") })).toBe("خط اول")
    expect(noteDisplayTitle({ title: "", body: null, plainText: "" })).toBe("یادداشت بی‌نام")
    expect(noteDisplayTitle({ title: "خرید", body: null, plainText: "نان" })).toBe("خرید")
    expect(noteExcerpt({ body: textToNoteBody("a".repeat(120)) }, 10)).toBe("aaaaaaaaaa…")
  })
})

describe("draft reconciliation", () => {
  const draft = (version: number, text: string) => ({
    version,
    text,
    savedAt: "2026-10-20T09:30:00.000Z"
  })

  it("parses only well-formed drafts", () => {
    expect(parseNoteDraft(serializeNoteDraft(draft(2, "متن")))).toEqual(draft(2, "متن"))
    expect(parseNoteDraft("not json")).toBeUndefined()
    expect(parseNoteDraft(JSON.stringify({ version: 1, text: "x" }))).toBeUndefined()
    expect(parseNoteDraft(undefined)).toBeUndefined()
  })

  it("applies a draft at the mirrored version after a sudden close", () => {
    expect(
      reconcileDraft({
        draft: draft(4, "نیمه‌نوشته"),
        serverVersion: 4,
        serverText: "قدیمی",
        hasPending: false
      })
    ).toEqual({ apply: true, text: "نیمه‌نوشته" })
  })

  it("applies a queued local edit even when the mirror is behind", () => {
    expect(
      reconcileDraft({
        draft: draft(2, "ویرایش محلی"),
        serverVersion: 5,
        serverText: "متن سرور",
        hasPending: true
      })
    ).toEqual({ apply: true, text: "ویرایش محلی" })
  })

  it("never clobbers newer server text", () => {
    expect(
      reconcileDraft({
        draft: draft(3, "پیش‌نویس کهنه"),
        serverVersion: 6,
        serverText: "متن تازه‌تر",
        hasPending: false
      })
    ).toEqual({ apply: false, reason: "server-newer" })
  })

  it("ignores an identical or empty draft", () => {
    expect(
      reconcileDraft({
        draft: draft(4, "همان"),
        serverVersion: 4,
        serverText: "همان",
        hasPending: false
      })
    ).toEqual({ apply: false, reason: "unchanged" })
    expect(
      reconcileDraft({
        draft: draft(4, ""),
        serverVersion: 4,
        serverText: "متن",
        hasPending: false
      })
    ).toEqual({ apply: false, reason: "empty" })
  })
})

describe("note mirror projections", () => {
  const row = (id: string, data: Record<string, unknown>, updatedAt: string) =>
    toNoteRow({ entityType: "note", entityId: id, version: 1, updatedAt, deletedAt: null, data })

  it("puts pinned notes first, then newest", () => {
    const rows = [
      row("a", { title: "الف" }, "2026-10-20T10:00:00.000Z"),
      row("b", { title: "ب", isPinned: true }, "2026-10-19T10:00:00.000Z"),
      row("c", { title: "ج", isPinned: true }, "2026-10-21T10:00:00.000Z")
    ]
    expect(sortNotes(rows).map((note) => note.id)).toEqual(["c", "b", "a"])
  })

  it("filters by any selected tag", () => {
    const rows = [
      row("a", { title: "الف", tagIds: ["t1"] }, "2026-10-20T10:00:00.000Z"),
      row("b", { title: "ب", tagIds: ["t2"] }, "2026-10-20T10:00:00.000Z"),
      row("c", { title: "ج", tagIds: [] }, "2026-10-20T10:00:00.000Z")
    ]
    expect(filterNotesByTags(rows, ["t2", "t1"]).map((note) => note.id)).toEqual(["a", "b"])
    expect(filterNotesByTags(rows, [])).toHaveLength(3)
  })
})

describe("quick create", () => {
  it("writes the note into the mirror and outbox before any network call", async () => {
    const store = await openLocalStore(`user-${uuidV7()}`)
    const id = await createNoteInMirror(store, "2026-10-20T09:30:00.000Z")

    const record = await store.get("note", id)
    expect(record).toMatchObject({
      version: 0,
      deletedAt: null,
      data: { id, type: "note", title: "", plainText: "", isPinned: false, tagIds: [] }
    })
    expect((await store.pending()).map((entry) => entry.entityId)).toEqual([id])
    expect((await store.list("note")).map((row) => row.entityId)).toEqual([id])
    expect(await store.readDraft(noteDraftKey(id))).toBeUndefined()
    store.close()
  })
})
