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

  it("folds unsent upserts for one row without inventing a server version", async () => {
    const store = await open(freshUser())
    const id = uuidV7()

    await writeTitle(store, id, "اول", "2026-10-20T09:00:00.000Z")
    const [first] = await store.pending()
    await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      patch: { checked: true },
      now: "2026-10-20T09:00:01.000Z"
    })

    const [row] = await store.list("listItem")
    expect(row!.version).toBe(0)
    expect(row!.data).toEqual({ title: "اول", checked: true })

    // Neither write invents a server version: the folded entry still
    // references the last version the client saw (0), and the push engine
    // rewrites any later anchor from the result of this one (sync-protocol
    // §4.1/§4.3).
    const pending = await store.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      seq: first!.seq,
      clientMutationId: first!.clientMutationId,
      baseVersion: 0,
      op: "upsert",
      patch: { title: "اول", checked: true },
      clientUpdatedAt: "2026-10-20T09:00:01.000Z",
      sent: false
    })
    store.close()
  })

  it("keeps the chain serial once an entry has been sent", async () => {
    const store = await open(freshUser())
    const id = uuidV7()
    await writeTitle(store, id, "اول", "2026-10-20T09:00:00.000Z")
    const [first] = await store.pending()

    // A push may already have applied this entry; its patch is frozen.
    await store.markSent([first!.clientMutationId])
    await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      patch: { checked: true },
      now: "2026-10-20T09:00:01.000Z"
    })

    const pending = await store.pending()
    expect(pending).toHaveLength(2)
    expect(pending[0]).toMatchObject({
      clientMutationId: first!.clientMutationId,
      patch: { title: "اول" },
      sent: true
    })
    expect(pending[1]).toMatchObject({
      op: "upsert",
      patch: { checked: true },
      baseVersion: 0,
      sent: false
    })
    store.close()
  })

  it("does not fold a write into another entity's entry", async () => {
    const store = await open(freshUser())
    const first = uuidV7()
    const second = uuidV7()

    await writeTitle(store, first, "یکی")
    await writeTitle(store, second, "دیگری")

    const pending = await store.pending()
    expect(pending.map((entry) => entry.entityId)).toEqual([first, second])
    expect(pending.map((entry) => entry.patch)).toEqual([{ title: "یکی" }, { title: "دیگری" }])
    store.close()
  })

  it("keeps delete and the empty-patch habit restore serial", async () => {
    const store = await open(freshUser())
    const id = uuidV7()
    const now = (second: number) => `2026-10-20T09:00:0${second}.000Z`

    await store.writeLocal({
      entityType: "habit",
      entityId: id,
      op: "upsert",
      patch: { title: "کتاب" },
      now: now(0)
    })
    await store.writeLocal({ entityType: "habit", entityId: id, op: "delete", patch: {}, now: now(1) })
    // The undo the screen queues: an empty upsert the engine repairs through
    // `RestoreHabit`. Folding it would erase the signal it is recognised by.
    await store.writeLocal({
      entityType: "habit",
      entityId: id,
      op: "upsert",
      patch: {},
      deletedAt: null,
      now: now(2)
    })
    // An edit right after the undo must not swallow it either.
    await store.writeLocal({
      entityType: "habit",
      entityId: id,
      op: "upsert",
      patch: { title: "ورزش" },
      now: now(3)
    })

    const pending = await store.pending()
    expect(pending.map((entry) => entry.op)).toEqual(["upsert", "delete", "upsert", "upsert"])
    expect(pending.map((entry) => entry.patch)).toEqual([
      { title: "کتاب" },
      {},
      {},
      { title: "ورزش" }
    ])
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
    await store.ack([entry!.clientMutationId], [authoritative])

    expect(await store.pending()).toHaveLength(0)
    expect(await store.get("listItem", id)).toMatchObject({ version: 7, updatedAt: authoritative.updatedAt })
    // `ack` never moves the pull cursor: a push's `seq` is not contiguous with
    // what this device has pulled (a remote change in between would be lost).
    expect(await store.cursor()).toBe(0)
    await store.setCursor(41)
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

  it("marks a rejected push and clears the marker on a later result", async () => {
    const store = await open(freshUser())
    const id = uuidV7()
    await writeTitle(store, id, "پیش‌نویس")
    const [entry] = await store.pending()
    const at = "2026-10-20T09:00:00.000Z"

    await store.ack([entry!.clientMutationId], [], [
      {
        entityType: "listItem",
        entityId: id,
        code: "InvalidPatch",
        message: "The patch value for \"title\" is not valid",
        at,
        clientMutationId: entry!.clientMutationId
      }
    ])

    expect(await store.pending()).toHaveLength(0)
    expect(await store.failedCount()).toBe(1)
    expect((await store.listFailed()).map((row) => row.entityId)).toEqual([id])
    expect((await store.get("listItem", id))!.syncError).toEqual({
      code: "InvalidPatch",
      message: "The patch value for \"title\" is not valid",
      at,
      clientMutationId: entry!.clientMutationId
    })

    // A newer local edit is not proof that the rejected fields reached the
    // server, so it keeps the marker.
    await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      patch: { checked: true }
    })
    expect((await store.get("listItem", id))!.syncError).not.toBeUndefined()

    // A later applied result resolves the entity and clears the marker even
    // when it carries no authoritative row to put.
    await store.ack([], [], [], [{ entityType: "listItem", entityId: id }])
    expect((await store.get("listItem", id))!.syncError).toBeUndefined()
    expect(await store.failedCount()).toBe(0)
    store.close()
  })

  it("clears a stale marker when a pull replaces the row", async () => {
    const store = await open(freshUser())
    const id = uuidV7()
    await writeTitle(store, id, "محلی")
    const [entry] = await store.pending()
    await store.ack([entry!.clientMutationId], [], [
      {
        entityType: "listItem",
        entityId: id,
        code: "UniqueViolation",
        message: "UNIQUE constraint failed",
        at: "2026-10-20T09:00:00.000Z",
        clientMutationId: entry!.clientMutationId
      }
    ])
    expect((await store.get("listItem", id))!.syncError).not.toBeUndefined()

    await store.mergeServer([
      {
        entityType: "listItem",
        entityId: id,
        version: 5,
        updatedAt: "2026-10-20T09:01:00.000Z",
        deletedAt: null,
        data: { title: "از سرور", checked: false, sortOrder: 0 }
      }
    ])

    const replaced = await store.get("listItem", id)
    expect(replaced).toMatchObject({ version: 5, data: { title: "از سرور" } })
    expect(replaced!.syncError).toBeUndefined()
    store.close()
  })

  it("requeues a failed row from current data with a fresh identity and anchor", async () => {
    const store = await open(freshUser())
    const id = uuidV7()
    await store.mergeServer([
      {
        entityType: "listItem",
        entityId: id,
        version: 4,
        updatedAt: "2026-10-20T09:00:00.000Z",
        deletedAt: null,
        data: { title: "مانده", checked: true, sortOrder: 2 }
      }
    ])
    await store.ack([], [], [
      {
        entityType: "listItem",
        entityId: id,
        code: "AttributionLimit",
        message: "attribution budget exhausted",
        at: "2026-10-20T09:00:01.000Z",
        clientMutationId: uuidV7()
      }
    ])

    const retried = await store.retryFailed("listItem", id)

    expect(retried!.syncError).toBeUndefined()
    expect((await store.get("listItem", id))!.syncError).toBeUndefined()
    const pending = await store.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      baseVersion: 4,
      patch: { title: "مانده", checked: true, sortOrder: 2 },
      sent: false
    })
    expect(pending[0]!.clientMutationId).toMatch(/^[0-9a-f-]{36}$/)
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

  it("keeps soft-deleted rows in trash and restores them in place", async () => {
    const store = await open(freshUser())
    const id = uuidV7()

    await writeTitle(store, id, "قابل بازیابی")
    await store.writeLocal({ entityType: "listItem", entityId: id, op: "delete", patch: {} })

    expect(await store.list("listItem")).toHaveLength(0)
    const trash = await store.listTrashed("listItem")
    expect(trash.map((row) => row.entityId)).toEqual([id])
    expect(trash[0]!.deletedAt).not.toBeNull()
    // The tab-off mutation carries the same intent to the server.
    expect((await store.pending()).map((entry) => entry.op)).toEqual(["upsert", "delete"])

    await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      patch: {},
      deletedAt: null
    })
    expect((await store.list("listItem")).map((row) => row.entityId)).toEqual([id])
    expect(await store.listTrashed("listItem")).toHaveLength(0)
    store.close()
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
