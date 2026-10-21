import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import { uuidV7 } from "@tali/domain"
import { openLocalStore } from "../local-store/store"
import type { LocalStore } from "../local-store/types"
import {
  createOccasionInMirror,
  formatOccasionDate,
  monthOccasions,
  prepareOccasionTaskInMirror,
  toOccasionRow,
  upcomingOccasions
} from "./model"

/**
 * Ticket #59 at the client seam: the mirror row hydrates the annual projection,
 * the panel's next occurrence uses the shared builders, and one tap creates a
 * real mirrored task plus the occasion link.
 */

const TZ = "Asia/Tehran"
const TODAY = "2026-10-21"

const withStore = async (run: (store: LocalStore) => Promise<void>): Promise<void> => {
  const store = await openLocalStore(uuidV7())
  try {
    await run(store)
  } finally {
    store.close()
  }
}

describe("occasions client model", () => {
  it("projects a mirrored occasion and formats both calendars", async () => {
    await withStore(async (store) => {
      await createOccasionInMirror(store, {
        title: "تولد مامان",
        originDate: "1990-04-01",
        timeZone: TZ,
        yearly: true,
        advanceReminderDays: 7
      })
      const rows = (await store.list("occasion")).map(toOccasionRow)
      const occurrences = monthOccasions(rows, "2026-04-01", "2026-04-30")
      expect(occurrences).toHaveLength(1)
      expect(occurrences[0]?.jalali).toEqual({ year: 1405, month: 1, day: 12 })
      expect(formatOccasionDate(occurrences[0]!, "persian")).toBe(
        "۱۲ فروردین ۱۴۰۵ · ۱ آوریل ۲۰۲۶"
      )

      const upcoming = upcomingOccasions(rows, TODAY)
      expect(upcoming[0]?.occurrence?.date).toBe("2027-04-01")
      expect(upcoming[0]?.occurrence?.advanceReminderDate).toBe("2027-03-25")
    })
  })

  it("creates the preparation task once and links it", async () => {
    await withStore(async (store) => {
      await createOccasionInMirror(store, {
        title: "تولد سارا",
        originDate: TODAY,
        timeZone: TZ,
        yearly: true,
        advanceReminderDays: 7
      })
      const [row] = (await store.list("occasion")).map(toOccasionRow)

      const first = await prepareOccasionTaskInMirror(store, row!, TODAY)
      expect(first.created).toBe(true)
      const task = await store.get("task", first.taskId)
      expect(task?.data.title).toBe("آماده‌سازی برای تولد سارا")
      expect(task?.data.dueDate).toBe("2026-10-14")
      expect((await store.get("occasion", row!.id))?.data.preparationTaskId).toBe(first.taskId)

      // A second tap is a no-op while the linked task is live.
      const [linked] = (await store.list("occasion")).map(toOccasionRow)
      const again = await prepareOccasionTaskInMirror(store, linked!, TODAY)
      expect(again).toEqual({ taskId: first.taskId, created: false })
      expect(await store.list("task")).toHaveLength(1)
    })
  })
})
