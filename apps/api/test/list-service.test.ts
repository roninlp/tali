import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  ListForbidden,
  uuidV7,
  type HouseholdId,
  type ListId,
  type ListItemId,
  type SyncPushEntry,
  type UserId
} from "@tali/domain"
import {
  ListService,
  ListServiceLive,
  type ListServiceApi,
  type ListViewer
} from "../src/list-service.js"
import { SyncService, SyncServiceLive } from "../src/sync-service.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #39 at the service/sync seam. These run the real ListService, repos
 * and sync primitives against SQLite through a D1-shaped batch, so version
 * bumps, `changes()` gating, feed appends and the replay ledger behave like
 * production. "Two devices" are independent cursors over the same server.
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)
const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort()

const USER_A = "user-a" as UserId
const USER_B = "user-b" as UserId
const HOUSEHOLD = "household-a" as HouseholdId
const NOW = "2026-10-20T09:30:00.000Z"

const viewer = (overrides: Partial<ListViewer> = {}): ListViewer => ({
  userId: USER_A,
  householdId: HOUSEHOLD,
  ...overrides
})

const makeHarness = () => {
  const db = new DatabaseSync(":memory:")
  for (const file of migrationFiles()) {
    db.exec(readFileSync(fileURLToPath(new URL(file, MIGRATIONS_DIR)), "utf8"))
  }
  const fake = new FakeD1(db)
  const d1 = D1Client.layer({
    db: fake.asD1Database(),
    transformQueryNames: Str.camelToSnake,
    transformResultNames: Str.snakeToCamel
  })
  const layer = Layer.mergeAll(ListServiceLive, SyncServiceLive).pipe(Layer.provide(d1))

  const run = <A, E>(effect: Effect.Effect<A, E, ListService | SyncService>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, layer))

  const svc = <A, E>(f: (service: ListServiceApi) => Effect.Effect<A, E, never>): Promise<A> =>
    run(
      Effect.gen(function*() {
        const service = yield* ListService
        return yield* f(service)
      })
    )

  const sync = <A, E>(f: (service: SyncService) => Effect.Effect<A, E, never>): Promise<A> =>
    run(
      Effect.gen(function*() {
        const service = yield* SyncService
        return yield* f(service)
      })
    )

  const pull = (userId: UserId, cursor: number) =>
    sync((service) => service.pull({ userId, householdId: HOUSEHOLD, cursor }))

  const push = (userId: UserId, entries: ReadonlyArray<SyncPushEntry>) =>
    sync((service) => service.push({ userId, householdId: HOUSEHOLD, entries }))

  const feedCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM change_feed").get() as { readonly n: number }).n

  return { db, fake, run, svc, sync, pull, push, feedCount }
}

const createSharedList = async (h: ReturnType<typeof makeHarness>, title = "خرید") =>
  h.svc((svc) =>
    svc.create(
      viewer(),
      {
        id: uuidV7() as ListId,
        clientMutationId: `list-${uuidV7()}`,
        title,
        color: "#0f9d8f",
        icon: "🛒",
        visibility: "shared"
      },
      NOW
    )
  )

describe("ListService round-trip", () => {
  it("creates a list, appends five items in one batch, reorders and checks", async () => {
    const h = makeHarness()
    const list = await createSharedList(h)

    const before = h.fake.batchCalls
    const appended = await h.svc((svc) =>
      svc.appendItems(
        viewer(),
        {
          listId: list.id,
          clientMutationId: "append-five",
          items: ["نان", "شیر", "تخم‌مرغ", "پنیر", "سبزی"].map((name) => ({
            id: uuidV7() as ListItemId,
            name
          }))
        },
        NOW
      )
    )
    // One commit batch for the whole five-item append.
    expect(h.fake.batchCalls - before).toBe(1)
    expect(appended.map((item) => item.name)).toEqual([
      "نان",
      "شیر",
      "تخم‌مرغ",
      "پنیر",
      "سبزی"
    ])
    expect(appended.map((item) => item.order)).toEqual([1, 2, 3, 4, 5])

    const reordered = await h.svc((svc) =>
      svc.reorder(
        viewer(),
        {
          listId: list.id,
          clientMutationId: "reorder",
          itemIds: [appended[2]!.id, appended[0]!.id, appended[1]!.id, appended[3]!.id, appended[4]!.id]
        },
        NOW
      )
    )
    expect(reordered.map((item) => item.name)).toEqual([
      "تخم‌مرغ",
      "نان",
      "شیر",
      "پنیر",
      "سبزی"
    ])
    expect(reordered.map((item) => item.order)).toEqual([1, 2, 3, 4, 5])

    const checked = await h.svc((svc) =>
      svc.setItemChecked(
        viewer(),
        { id: reordered[0]!.id, clientMutationId: "check", checked: true },
        NOW
      )
    )
    expect(checked.done).toBe(true)
    expect(checked.checkedAt).toBe(NOW)

    // Idempotent re-check: no new version, no new feed row.
    const feedBefore = h.feedCount()
    const again = await h.svc((svc) =>
      svc.setItemChecked(
        viewer(),
        { id: reordered[0]!.id, clientMutationId: "check-again", checked: true },
        NOW
      )
    )
    expect(again.version).toBe(checked.version)
    expect(h.feedCount()).toBe(feedBefore)

    const undone = await h.svc((svc) =>
      svc.setItemChecked(
        viewer(),
        { id: reordered[0]!.id, clientMutationId: "undo", checked: false },
        NOW
      )
    )
    expect(undone.done).toBe(false)
    expect(undone.checkedAt).toBeNull()
    expect(undone.version).toBe(checked.version + 1)
  })

  it("renames a list and keeps the checked item at the bottom preference", async () => {
    const h = makeHarness()
    const list = await createSharedList(h, "کارهای خانه")
    expect(list.sort).toBe("manual")
    expect(list.checkedPlacement).toBe("bottom")

    const renamed = await h.svc((svc) =>
      svc.update(
        viewer(),
        {
          id: list.id,
          clientMutationId: "rename",
          patch: { title: "کارهای هفتگی", sort: "alpha", checkedPlacement: "inPlace" }
        },
        NOW
      )
    )
    expect(renamed).toMatchObject({
      title: "کارهای هفتگی",
      sort: "alpha",
      checkedPlacement: "inPlace",
      version: list.version + 1
    })
  })
})

describe("two-device convergence", () => {
  it("shows A's check and B's rename through the cursor feed", async () => {
    const h = makeHarness()
    const list = await createSharedList(h)
    const [item] = await h.svc((svc) =>
      svc.appendItems(
        viewer(),
        {
          listId: list.id,
          clientMutationId: "append",
          items: [{ id: uuidV7() as ListItemId, name: "شیر" }]
        },
        NOW
      )
    )

    // Device A checks the item.
    await h.svc((svc) =>
      svc.setItemChecked(viewer(), { id: item!.id, clientMutationId: "a-check", checked: true }, NOW)
    )

    // Device B pulls from 0 and sees the checked item.
    const bPull = await h.pull(USER_B, 0)
    const bItem = bPull.items.find(
      (row) => row.entityType === "listItem" && row.entityId === item!.id
    )
    expect(bItem?.data).toMatchObject({ checked: true, done: true, name: "شیر" })
    expect(bPull.entries.find((entry) => entry.entityId === item!.id)?.ownerId).toBe(USER_A)

    // Device B renames the shared list.
    await h.svc(
      (svc) =>
        svc.update(
          viewer({ userId: USER_B }),
          { id: list.id, clientMutationId: "b-rename", patch: { title: "خرید خانه" } },
          NOW
        )
    )

    // Device A pulls from B's cursor and sees the rename.
    const aPull = await h.pull(USER_A, bPull.nextCursor)
    const aList = aPull.items.find((row) => row.entityType === "list" && row.entityId === list.id)
    expect(aList?.data.title).toBe("خرید خانه")
    // `lastWriterId` is the actual writer (the row owner is still USER_A).
    expect(aList?.data.lastWriterId).toBe(USER_B)
    expect(aList?.data.ownerId).toBe(USER_A)
    expect(bItem?.data.lastWriterId).toBe(USER_A)
  })

  it("keeps ticked-wins on a stale concurrent uncheck", async () => {
    const h = makeHarness()
    const list = await createSharedList(h)
    const item = await h.svc((svc) =>
      svc.createItem(
        viewer(),
        { id: uuidV7() as ListItemId, clientMutationId: "create", listId: list.id, name: "دارو" },
        NOW
      )
    )
    await h.svc((svc) =>
      svc.setItemChecked(viewer(), { id: item.id, clientMutationId: "a-check", checked: true }, NOW)
    )

    // Device B edited against version 1 (before A's tick) and tries to uncheck.
    const entry: SyncPushEntry = {
      clientMutationId: "b-stale-uncheck",
      entityType: "listItem",
      entityId: item.id,
      baseVersion: 1,
      op: "upsert",
      patch: { checked: false, done: false },
      clientUpdatedAt: "2026-10-20T09:31:00.000Z"
    }
    const result = await h.push(USER_B, [entry])
    const outcome = result.results[0]!
    expect(outcome._tag).toBe("conflict")
    expect(outcome.item?.data).toMatchObject({ checked: true, done: true })

    const pull = await h.pull(USER_B, 0)
    const current = pull.items.find((row) => row.entityId === item.id)
    expect(current?.data).toMatchObject({ checked: true, done: true })
  })
})

describe("sharing and privacy", () => {
  it("keeps a private list owner-only for reads and writes", async () => {
    const h = makeHarness()
    const list = await h.svc((svc) =>
      svc.create(
        viewer(),
        {
          id: uuidV7() as ListId,
          clientMutationId: "private-list",
          title: "یادداشت‌های من",
          visibility: "private"
        },
        NOW
      )
    )
    const item = await h.svc((svc) =>
      svc.createItem(
        viewer(),
        { id: uuidV7() as ListItemId, clientMutationId: "private-item", listId: list.id, name: "خصوصی" },
        NOW
      )
    )

    await expect(h.svc((svc) => svc.get(viewer({ userId: USER_B }), list.id))).rejects.toBeInstanceOf(
      ListForbidden
    )
    await expect(
      h.svc((svc) =>
        svc.setItemChecked(
          viewer({ userId: USER_B }),
          { id: item.id, clientMutationId: "b-check", checked: true },
          NOW
        )
      )
    ).rejects.toBeInstanceOf(ListForbidden)

    const bLists = await h.svc((svc) => svc.list(viewer({ userId: USER_B })))
    expect(bLists.map((entry) => entry.id)).not.toContain(list.id)

    const bPull = await h.pull(USER_B, 0)
    expect(bPull.items.some((row) => row.entityId === list.id)).toBe(false)
    expect(bPull.items.some((row) => row.entityId === item.id)).toBe(false)
  })

  it("lets both members edit a shared list and item", async () => {
    const h = makeHarness()
    const list = await createSharedList(h)
    const item = await h.svc((svc) =>
      svc.createItem(
        viewer(),
        { id: uuidV7() as ListItemId, clientMutationId: "shared-item", listId: list.id, name: "نان" },
        NOW
      )
    )

    const bCheck = await h.svc(
      (svc) =>
        svc.setItemChecked(
          viewer({ userId: USER_B }),
          { id: item.id, clientMutationId: "b-check", checked: true },
          NOW
        )
    )
    expect(bCheck.done).toBe(true)

    const aRename = await h.svc(
      (svc) =>
        svc.update(
          viewer(),
          { id: list.id, clientMutationId: "a-rename", patch: { title: "نان و شیر" } },
          NOW
        )
    )
    expect(aRename.title).toBe("نان و شیر")
  })
})

describe("reorder replay and delete", () => {
  it("replays a reorder without minting versions and cascades a delete", async () => {
    const h = makeHarness()
    const list = await createSharedList(h)
    const items = await h.svc((svc) =>
      svc.appendItems(
        viewer(),
        {
          listId: list.id,
          clientMutationId: "append",
          items: ["یک", "دو", "سه"].map((name) => ({ id: uuidV7() as ListItemId, name }))
        },
        NOW
      )
    )
    const order = [items[2]!.id, items[0]!.id, items[1]!.id]
    const reordered = await h.svc((svc) =>
      svc.reorder(
        viewer(),
        { listId: list.id, clientMutationId: "reorder", itemIds: order },
        NOW
      )
    )
    const feedBefore = h.feedCount()

    const replay = await h.svc((svc) =>
      svc.reorder(
        viewer(),
        { listId: list.id, clientMutationId: "reorder", itemIds: order },
        NOW
      )
    )
    expect(replay.map((item) => item.id)).toEqual(reordered.map((item) => item.id))
    expect(h.feedCount()).toBe(feedBefore)

    await h.svc((svc) =>
      svc.remove(viewer(), { id: list.id, clientMutationId: "delete-list" }, NOW)
    )
    const after = await h.svc((svc) => svc.list(viewer()))
    expect(after.map((entry) => entry.id)).not.toContain(list.id)
    const afterPull = await h.pull(USER_A, 0)
    expect(
      afterPull.items.some(
        (row) =>
          row.entityType === "listItem" &&
          row.deletedAt === null &&
          items.some((item) => item.id === row.entityId)
      )
    ).toBe(false)
  })
})
