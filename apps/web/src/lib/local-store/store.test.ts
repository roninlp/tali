import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import { uuidV7 } from "@tali/domain"
import { openLocalStore } from "./store"
import type { LocalStore, ServerRow } from "./types"

const freshUser = (): string => `user-${uuidV7()}`

const open = async (userId: string): Promise<LocalStore> => openLocalStore(userId)

const writeTitle = (
  store: LocalStore,
  entityId: string,
  title: string,
  now = new Date().toISOString()
) =>
  store.writeLocal({
    entityType: "listItem",
    entityId,
    op: "upsert",
    patch: { title },
    now
  })

describe("local store", () => {
  it("writes the mirror row and the outbox entry together", async () => {
    const store = await open(freshUser())
    const id = uuidV7()

    const row = await writeTitle(store, id, "خرید نان")

    expect(row.entityId).toBe(id)
    expect(row.version).toBe(0)
    expect(row.deletedAt).toBeNull()
    expect(row.data).toEqual({ title: "خرید نان" })

    expect(await store.list("listItem")).toHaveLength(1)
    const pending = await store.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      entityType: "listItem",
      entityId: id,
      baseVersion: 0,
      op: "upsert",
      patch: { title: "خرید نان" }
    })
    expect(pending[0]!.clientMutationId).toMatch(/^[0-9a-f-]{36}$/)

    store.close()
  })

  it("survives a reload: a new connection sees the write and its queued mutation", async () => {
    const userId = freshUser()
    const id = uuidV7()

    const first = await open(userId)
    await writeTitle(first, id, "تمرین صبح")
    first.close()

    const second = await open(userId)
    const rows = await second.list("listItem")
    const pending = await second.pending()

    expect(rows.map((row) => row.data.title)).toEqual(["تمرین صبح"])
    expect(pending).toHaveLength(1)
    expect(pending[0]!.entityId).toBe(id)
    second.close()
  })

  it("chains writes on the same row without inventing a server version", async () => {
    const store = await open(freshUser())
    const id = uuidV7()

    await writeTitle(store, id, "اول")
    await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      patch: { checked: true }
    })

    const [row] = await store.list("listItem")
    expect(row!.version).toBe(0)
    expect(row!.data).toEqual({ title: "اول", checked: true })

    const pending = await store.pending()
    expect(pending).toHaveLength(2)
    // Neither entry invents a server version: both still reference the last
    // version the client saw (0). The push engine rewrites the second anchor
    // from the first entry's push result (sync-protocol §4.1/§4.3).
    expect(pending.map((entry) => entry.baseVersion)).toEqual([0, 0])
    expect(pending[1]!.patch).toEqual({ checked: true })
    store.close()
  })

  it("soft-deletes with a tombstone and hides the row from lists", async () => {
    const store = await open(freshUser())
    const id = uuidV7()
    await writeTitle(store, id, "حذف‌شدنی")

    const deleted = await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "delete",
      patch: {}
    })

    expect(deleted.deletedAt).not.toBeNull()
    expect(await store.list("listItem")).toHaveLength(0)
    expect(await store.get("listItem", id)).toMatchObject({ deletedAt: deleted.deletedAt })

    const pending = await store.pending()
    expect(pending.at(-1)).toMatchObject({ op: "delete", entityId: id })
    store.close()
  })

  it("merges server rows but never clobbers a row with a pending mutation", async () => {
    const store = await open(freshUser())
    const queued = uuidV7()
    const clean = uuidV7()
    await writeTitle(store, queued, "ویرایش محلی")

    const server = (id: string, title: string): ServerRow => ({
      entityType: "listItem",
      entityId: id,
      version: 4,
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      data: { title }
    })

    const applied = await store.mergeServer([server(queued, "نسخه‌ی سرور"), server(clean, "از سرور")])

    expect(applied).toBe(1)
    expect((await store.get("listItem", queued))!.data).toEqual({ title: "ویرایش محلی" })
    expect((await store.get("listItem", clean))!.data).toEqual({ title: "از سرور" })
    store.close()
  })

  it("acks queued mutations and adopts the authoritative row", async () => {
    const store = await open(freshUser())
    const id = uuidV7()
    await writeTitle(store, id, "پیش‌نویس")
    const [entry] = await store.pending()

    const authoritative: ServerRow = {
      entityType: "listItem",
      entityId: id,
      version: 7,
      updatedAt: "2026-10-19T08:00:00.000Z",
      deletedAt: null,
      data: { title: "پیش‌نویس", checked: false, sortOrder: 0 }
    }
    await store.ack([entry!.clientMutationId], [authoritative], 41)

    expect(await store.pending()).toHaveLength(0)
    expect(await store.get("listItem", id)).toMatchObject({ version: 7, updatedAt: authoritative.updatedAt })
    // The push response's `seq` advances the pull cursor in the same
    // transaction, and a stale value cannot rewind it.
    expect(await store.cursor()).toBe(41)
    await store.ack([], [], 12)
    expect(await store.cursor()).toBe(41)

    // The next local edit uses the server version as its concurrency anchor.
    await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      patch: { checked: true }
    })
    expect((await store.pending())[0]!.baseVersion).toBe(7)
    store.close()
  })

  it("removes a mirror row the server no longer shows, without queueing a mutation", async () => {
    const store = await open(freshUser())
    const id = uuidV7()
    await store.mergeServer([
      {
        entityType: "listItem",
        entityId: id,
        version: 3,
        updatedAt: new Date().toISOString(),
        deletedAt: null,
        data: { title: "خصوصی شد" }
      }
    ])

    await store.removeFromMirror("listItem", id)

    expect(await store.get("listItem", id)).toBeUndefined()
    expect(await store.list("listItem")).toHaveLength(0)
    // A visibility flip is not a local delete: nothing is queued to push.
    expect(await store.pending()).toHaveLength(0)
    store.close()
  })

  it("moves the cursor forward only", async () => {
    const store = await open(freshUser())
    expect(await store.cursor()).toBe(0)
    await store.setCursor(12)
    await store.setCursor(3)
    expect(await store.cursor()).toBe(12)
    store.close()
  })

  it("keeps drafts across a reload", async () => {
    const userId = freshUser()
    const first = await open(userId)
    await first.saveDraft("today.quickAdd.title", "نیمه‌نوشته")
    first.close()

    const second = await open(userId)
    expect(await second.readDraft("today.quickAdd.title")).toBe("نیمه‌نوشته")
    await second.clearDraft("today.quickAdd.title")
    expect(await second.readDraft("today.quickAdd.title")).toBeUndefined()
    second.close()
  })

  it("isolates mirrors per user", async () => {
    const a = await open(freshUser())
    const b = await open(freshUser())
    await writeTitle(a, uuidV7(), "کاربر الف")

    expect(await a.list("listItem")).toHaveLength(1)
    expect(await b.list("listItem")).toHaveLength(0)
    a.close()
    b.close()
  })

  it("clears every store", async () => {
    const store = await open(freshUser())
    await writeTitle(store, uuidV7(), "پاک‌شدنی")
    await store.saveDraft("d", "v")
    await store.setCursor(4)

    await store.clear()

    expect(await store.list("listItem")).toHaveLength(0)
    expect(await store.pending()).toHaveLength(0)
    expect(await store.readDraft("d")).toBeUndefined()
    expect(await store.cursor()).toBe(0)
    store.close()
  })
})

describe("uuidV7", () => {
  it("sets the version and variant bits and sorts by timestamp", () => {
    const earlier = uuidV7(1_700_000_000_000)
    const later = uuidV7(1_700_000_000_001)

    expect(earlier[14]).toBe("7")
    expect(["8", "9", "a", "b"]).toContain(earlier[19])
    expect(earlier < later).toBe(true)
  })
})
