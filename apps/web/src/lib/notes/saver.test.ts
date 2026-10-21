import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import { uuidV7 } from "@tali/domain"
import { openLocalStore } from "../local-store/store"
import { noteTextFromData, textToNoteBody } from "./body"
import { noteDraftKey, parseNoteDraft, reconcileDraft, serializeNoteDraft } from "./draft"
import { createNoteInMirror } from "./mirror"
import { createNoteSaver } from "./saver"

/**
 * Autosave/draft behaviour of the note editor, without rendering Solid:
 * identical saves are deduped (one server version per real edit), the mirror
 * commits before the network, and a draft survives a reload/draft-first
 * reconciliation.
 */

const open = () => openLocalStore(`user-${uuidV7()}`)

describe("note autosave", () => {
  it("commits text to the mirror and queues exactly one mutation per edit", async () => {
    const store = await open()
    const id = await createNoteInMirror(store)
    const saver = createNoteSaver(store, id, { title: "", text: "" })

    expect(await saver.save({ title: "", text: "" })).toBe("unchanged")
    expect(await store.pending()).toHaveLength(1) // the quick-create insert only

    expect(await saver.save({ title: "", text: "نان سنگک" })).toBe("saved")
    expect(await saver.save({ title: "", text: "نان سنگک" })).toBe("unchanged")
    expect(await store.pending()).toHaveLength(2)

    const record = await store.get("note", id)
    expect(noteTextFromData(record!.data)).toBe("نان سنگک")
    expect(record!.data.body).toEqual(textToNoteBody("نان سنگک"))

    // A second real edit is a second mutation, still anchored to the last
    // server version (the ack has not landed yet).
    expect(await saver.save({ title: "", text: "نان سنگک و پنیر" })).toBe("saved")
    const pending = await store.pending()
    expect(pending).toHaveLength(3)
    expect(pending[2]).toMatchObject({ entityType: "note", entityId: id, baseVersion: 0 })
    store.close()
  })

  it("clears the crash draft once the mirror write is durable", async () => {
    const store = await open()
    const id = await createNoteInMirror(store)
    await store.saveDraft(
      noteDraftKey(id),
      serializeNoteDraft({ version: 0, text: "نیمه‌نوشته", savedAt: new Date().toISOString() })
    )

    const saver = createNoteSaver(store, id, { title: "", text: "" })
    await saver.save({ title: "", text: "نیمه‌نوشته" })

    expect(await store.readDraft(noteDraftKey(id))).toBeUndefined()
    expect(noteTextFromData((await store.get("note", id))!.data)).toBe("نیمه‌نوشته")
    store.close()
  })

  it("recovers a draft after a reload without clobbering a newer server row", async () => {
    const userId = `user-${uuidV7()}`
    const id = uuidV7()
    const first = await openLocalStore(userId)

    // The editor wrote a draft, then the tab closed before autosave committed.
    await first.saveDraft(
      noteDraftKey(id),
      serializeNoteDraft({ version: 3, text: "پیش‌نویس", savedAt: "2026-10-20T09:30:00.000Z" })
    )
    first.close()

    const second = await openLocalStore(userId)
    const raw = await second.readDraft(noteDraftKey(id))
    const draft = parseNoteDraft(raw)
    expect(draft?.text).toBe("پیش‌نویس")

    // Meanwhile the server row advanced to version 5: newer text wins.
    expect(
      reconcileDraft({
        draft,
        serverVersion: 5,
        serverText: "متن تازه از دستگاه دیگر",
        hasPending: false
      })
    ).toEqual({ apply: false, reason: "server-newer" })

    // Without a newer server version the draft is restored and saved.
    expect(
      reconcileDraft({ draft, serverVersion: 3, serverText: "قدیمی", hasPending: false })
    ).toEqual({ apply: true, text: "پیش‌نویس" })
    second.close()
  })
})
