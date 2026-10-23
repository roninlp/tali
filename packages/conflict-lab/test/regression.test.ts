import { describe, expect, it } from "vitest"
import { uuidV7 } from "@tali/domain"
import {
  assertConverged,
  createHousehold,
  freshHousehold,
  makeTransport,
  newTelemetry,
  openDevice,
  queueWrite,
  registerAccount,
  serverSnapshot,
  settle,
  syncDevice,
  type Account,
  type Device
} from "./harness"

/**
 * The regression table the conflict lab promises (#83): the races this
 * codebase has actually hit, pinned with deterministic, non-property tests.
 * Each case is cheap insurance against a resolver change silently
 * reintroducing one of them.
 */

const closeAll = (devices: ReadonlyArray<Device>): void => {
  for (const device of devices) device.store.close()
}

/**
 * An edit instant safely ahead of the server's commit clock, so a field-LWW
 * test never depends on wall-clock ordering or a fabricated past date.
 */
const after = (offsetMs: number): string =>
  new Date(Date.now() + 60_000 + offsetMs).toISOString()

/** Two devices for one user, both in sync on an empty household. */
const twoDevices = async (
  label: string
): Promise<{ account: Account; a: Device; b: Device }> => {
  const account = await registerAccount(label)
  await createHousehold(account)
  const a = await openDevice(account, "A")
  const b = await openDevice(account, "B")
  return { account, a, b }
}

/** Create a row on A, then bring both mirrors to the same version. */
const seedShared = async (
  a: Device,
  b: Device,
  entityType: "task" | "listItem" | "note",
  patch: Record<string, unknown>
): Promise<string> => {
  const entityId = uuidV7()
  await queueWrite(
    a,
    { entityType, entityId, op: "upsert", patch, now: after(0) },
    `seed-${entityId}`
  )
  await settle([a, b])
  return entityId
}

describe("conflict regression table", () => {
  it("a stale CAS anchor converges with both fields kept, and bumps the version once", async () => {
    const { account, a, b } = await twoDevices("cas")
    try {
      const taskId = await seedShared(a, b, "task", { title: "نام نخست" })
      expect((await a.store.get("task", taskId))?.version).toBe(1)

      // Both devices wrote against version 1. A reaches the server first; B's
      // anchor is now stale, which is the lost-CAS situation.
      await queueWrite(
        a,
        {
          entityType: "task",
          entityId: taskId,
          op: "upsert",
          patch: { title: "نام تازه" },
          now: after(0)
        },
        "cas-a-title"
      )
      await queueWrite(
        b,
        {
          entityType: "task",
          entityId: taskId,
          op: "upsert",
          patch: { priority: "high" },
          now: after(1_000)
        },
        "cas-b-priority"
      )

      expect(await syncDevice(a)).toBe(true)
      expect(await syncDevice(b)).toBe(true)
      await settle([a, b])

      const row = await a.store.get("task", taskId)
      expect(row?.version).toBe(3)
      expect(row?.data.title).toBe("نام تازه")
      expect(row?.data.priority).toBe("high")

      // B took the conflict path (not an applied fast path).
      const tags = b.telemetry.results
        .filter((result) => result.clientMutationId === "cas-b-priority")
        .map((result) => result._tag)
      expect(tags).toEqual(["conflict"])
      await assertConverged([a, b], account)
    } finally {
      closeAll([a, b])
    }
  })

  it("a duplicate mutation id is deduped exactly: one applied, one alreadyApplied, one feed row", async () => {
    const { account, a } = await twoDevices("dedupe")
    try {
      const taskId = uuidV7()
      await queueWrite(
        a,
        { entityType: "task", entityId: taskId, op: "upsert", patch: { title: "یک‌بار" } },
        "dedupe-1"
      )

      // The request is sent twice with the same mutation id, as a client
      // retrying after a lost response would.
      a.options.duplicatePush = true
      expect(await syncDevice(a)).toBe(true)
      a.options.duplicatePush = false

      const tags = a.telemetry.results
        .filter((result) => result.clientMutationId === "dedupe-1")
        .map((result) => result._tag)
      expect(tags).toEqual(["applied", "alreadyApplied"])
      expect((await a.store.get("task", taskId))?.version).toBe(1)
      expect(await a.store.pendingCount()).toBe(0)

      // One mutation, one feed entry: the dedupe did not append a second.
      const feed = await makeTransport(account, { telemetry: newTelemetry() })
        .pull(0, 500)
      expect(feed.entries.filter((entry) => entry.entityId === taskId)).toHaveLength(1)
    } finally {
      closeAll([a])
    }
  })

  it("a private row cannot be replayed through push by the partner", async () => {
    const { owner, partner } = await freshHousehold()
    const ownerDevice = await openDevice(owner, "A")
    const partnerDevice = await openDevice(partner, "P")
    try {
      const taskId = uuidV7()
      await queueWrite(
        ownerDevice,
        {
          entityType: "task",
          entityId: taskId,
          op: "upsert",
          patch: { title: "خصوصی", visibility: "private" }
        },
        "owner-private"
      )
      await settle([ownerDevice])
      expect(await partnerDevice.store.get("task", taskId)).toBeUndefined()

      // The partner never saw the row, but tries to write the same id: the
      // server must refuse, and the engine must drop the forged local row.
      await queueWrite(
        partnerDevice,
        {
          entityType: "task",
          entityId: taskId,
          op: "upsert",
          patch: { title: "هجوم" }
        },
        "partner-hijack"
      )
      expect(await syncDevice(partnerDevice)).toBe(true)

      expect(await partnerDevice.store.get("task", taskId)).toBeUndefined()
      expect(partnerDevice.telemetry.results).toHaveLength(0)
      expect(await partnerDevice.store.pendingCount()).toBe(0)

      const server = await serverSnapshot(owner)
      const row = server.find((candidate) => candidate.entityId === taskId)
      expect(row?.data.title).toBe("خصوصی")
      expect(row?.data.visibility).toBe("private")
      expect(await ownerDevice.store.get("task", taskId)).toMatchObject({
        data: { title: "خصوصی" }
      })
    } finally {
      closeAll([ownerDevice, partnerDevice])
    }
  })

  it("completion wins over a concurrent rename, and the rename still lands", async () => {
    const { account, a, b } = await twoDevices("done-wins")
    try {
      const taskId = await seedShared(a, b, "task", { title: "کار" })

      await queueWrite(
        a,
        {
          entityType: "task",
          entityId: taskId,
          op: "upsert",
          patch: { status: "done" },
          now: after(0)
        },
        "done-a"
      )
      await queueWrite(
        b,
        {
          entityType: "task",
          entityId: taskId,
          op: "upsert",
          patch: { title: "نام بهتر" },
          now: after(5_000)
        },
        "rename-b"
      )

      expect(await syncDevice(a)).toBe(true)
      expect(await syncDevice(b)).toBe(true)
      await settle([a, b])

      const row = await a.store.get("task", taskId)
      expect(row?.data.status).toBe("done")
      expect(row?.data.title).toBe("نام بهتر")
      await assertConverged([a, b], account)
    } finally {
      closeAll([a, b])
    }
  })

  it("delete wins: an offline edit cannot resurrect a tombstoned row", async () => {
    const { account, a, b } = await twoDevices("delete-wins")
    try {
      const taskId = await seedShared(a, b, "task", { title: "حذف‌شدنی" })

      // B deletes it while A is still offline with an edit.
      await queueWrite(
        b,
        { entityType: "task", entityId: taskId, op: "delete", patch: {} },
        "delete-b"
      )
      await queueWrite(
        a,
        {
          entityType: "task",
          entityId: taskId,
          op: "upsert",
          patch: { title: "زنده بمان" },
          now: after(0)
        },
        "edit-a"
      )

      expect(await syncDevice(b)).toBe(true)
      expect(await syncDevice(a)).toBe(true)

      const tags = a.telemetry.results
        .filter((result) => result.clientMutationId === "edit-a")
        .map((result) => result._tag)
      expect(tags).toEqual(["tombstone"])

      await settle([a, b])
      expect((await a.store.get("task", taskId))?.deletedAt).not.toBeNull()
      const server = await serverSnapshot(account)
      expect(server.some((row) => row.entityId === taskId)).toBe(false)
      await assertConverged([a, b], account)
    } finally {
      closeAll([a, b])
    }
  })

  it("field LWW is granular: two devices editing different fields both keep their write", async () => {
    const { account, a, b } = await twoDevices("lww")
    try {
      const noteId = await seedShared(a, b, "note", {
        title: "یادداشت",
        plainText: "متن نخست"
      })

      await queueWrite(
        a,
        {
          entityType: "note",
          entityId: noteId,
          op: "upsert",
          patch: { title: "عنوان الف" },
          now: after(0)
        },
        "lww-a"
      )
      await queueWrite(
        b,
        {
          entityType: "note",
          entityId: noteId,
          op: "upsert",
          patch: { plainText: "متن ب" },
          now: after(5_000)
        },
        "lww-b"
      )

      expect(await syncDevice(a)).toBe(true)
      expect(await syncDevice(b)).toBe(true)
      await settle([a, b])

      const row = await a.store.get("note", noteId)
      expect(row?.data.title).toBe("عنوان الف")
      expect(row?.data.plainText).toBe("متن ب")
      await assertConverged([a, b], account)
    } finally {
      closeAll([a, b])
    }
  })

  it("an offline habit tap revives a tombstoned entry in place through the service path", async () => {
    const { account, a, b } = await twoDevices("revive")
    try {
      const habitId = uuidV7()
      const entryId = uuidV7()
      const localDate = "2026-10-20"

      await queueWrite(
        a,
        {
          entityType: "habit",
          entityId: habitId,
          op: "upsert",
          patch: {
            title: "ورزش",
            frequency: { _tag: "daily" },
            timeZone: "Asia/Tehran"
          },
          now: after(0)
        },
        "habit-create"
      )
      await queueWrite(
        a,
        {
          entityType: "habitEntry",
          entityId: entryId,
          op: "upsert",
          patch: { habitId, localDate, status: "done", timeZone: "Asia/Tehran" },
          now: after(1_000)
        },
        "entry-create"
      )
      await settle([a, b])
      expect((await b.store.get("habitEntry", entryId))?.version).toBe(1)

      // A marks the day done -> deletes it. B, offline, taps the same day.
      await queueWrite(
        a,
        { entityType: "habitEntry", entityId: entryId, op: "delete", patch: {} },
        "entry-delete"
      )
      expect(await syncDevice(a)).toBe(true)

      await queueWrite(
        b,
        {
          entityType: "habitEntry",
          entityId: entryId,
          op: "upsert",
          patch: { habitId, localDate, status: "partial", timeZone: "Asia/Tehran" },
          now: after(0)
        },
        "entry-tap"
      )

      // The generic resolver answers `tombstone`; the engine must call
      // `LogHabitEntry`, which resolves the day and revives the same row.
      expect(await syncDevice(b)).toBe(true)

      const revived = await b.store.get("habitEntry", entryId)
      expect(revived?.deletedAt).toBeNull()
      expect(revived?.data.status).toBe("partial")
      expect(revived?.version).toBeGreaterThan(1)
      expect(await b.store.pendingCount()).toBe(0)

      await settle([a, b])
      await assertConverged([a, b], account)
      expect(await makeTransport(account, { telemetry: newTelemetry() })
        .bootstrap(0, 500)).toMatchObject({ hasMore: false })
    } finally {
      closeAll([a, b])
    }
  })
})
