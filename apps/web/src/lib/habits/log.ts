import {
  type HabitEntryStatus,
  HabitEntryOutOfWindow,
  habitLogWindow,
  isHabitLogDateInWindow,
  localDateIn,
  nextHabitEntryStatus,
  uuidV7
} from "@tali/domain"
import type { LocalStore, MirrorRecord } from "../local-store"

/**
 * The daily habit tap, client side (ticket #64; FR-HAB-02).
 *
 * A tap is a **local-first upsert against the day**, not an insert against an
 * id: the mirror is searched for the row with the same `habitId` + `localDate`,
 * and that row's id is reused. Tapping twice therefore rewrites one mirror row
 * and queues two patches against the same entity — never two rows. The status
 * cycles Done → Partial → Missed (`nextHabitEntryStatus`), computed before the
 * write so the UI has the whole answer offline.
 *
 * The ≤ 7-day backdating window is checked here too, before anything is
 * written: an old day throws the same typed `HabitEntryOutOfWindow` the server
 * returns, so the UI can show one message whether it is online or offline.
 *
 * The write sequence is the #17 contract: `writeLocal` commits the mirror row
 * **and** the outbox entry in one IndexedDB transaction. Nothing is sent until
 * the sync engine drains the outbox.
 */

/** The status currently mirrored for a day, or `null` when it has none. */
export const habitEntryStatusOf = (
  record: MirrorRecord | undefined
): HabitEntryStatus | null => {
  const status = record?.data.status
  return status === "done" || status === "partial" || status === "missed" ? status : null
}

/**
 * The day's row in the mirror — live **or tombstoned**.
 *
 * A tombstoned row is included on purpose: re-logging a day the user had
 * cleared must revive the same entity id (which is also what the server does),
 * not mint a second id for the same `(habit, day)`.
 */
export const findHabitEntryRecord = async (
  store: LocalStore,
  habitId: string,
  localDate: string
): Promise<MirrorRecord | undefined> => {
  const [live, trashed] = await Promise.all([
    store.list("habitEntry"),
    store.listTrashed("habitEntry")
  ])
  return [...live, ...trashed].find(
    (record) =>
      record.data.habitId === habitId && record.data.localDate === localDate
  )
}

export interface HabitTapInput {
  readonly habitId: string
  /** The wall date being logged (`YYYY-MM-DD`). */
  readonly localDate: string
  /** The zone the tap happened in (the user's IANA zone). */
  readonly timeZone: string
  /**
   * The answer to record. Omit it for a plain tap: the helper cycles from the
   * day's current status (Done → Partial → Missed → Done).
   */
  readonly status?: HabitEntryStatus
  /** The habit's visibility, if the caller already has the habit row. */
  readonly visibility?: "private" | "shared"
  /** A client-minted id for a day that has never been logged locally. */
  readonly id?: string
  readonly clientMutationId?: string
  /** Test seam; defaults to the current instant. */
  readonly now?: string
}

/**
 * Apply one tap to the local mirror and queue its outbox mutation.
 *
 * Resolves only after IndexedDB commits, so a resolved call means the tap is
 * durable (and visible) even if the browser goes offline immediately after.
 */
export const tapHabitEntry = async (
  store: LocalStore,
  input: HabitTapInput
): Promise<MirrorRecord> => {
  const now = input.now ?? new Date().toISOString()
  const today = localDateIn(now, input.timeZone)

  if (!isHabitLogDateInWindow(input.localDate as HabitEntryOutOfWindow["localDate"], today)) {
    const window = habitLogWindow(today)
    throw new HabitEntryOutOfWindow({
      localDate: input.localDate as HabitEntryOutOfWindow["localDate"],
      earliest: window.earliest,
      latest: window.latest
    })
  }

  const current = await findHabitEntryRecord(store, input.habitId, input.localDate)
  const status = input.status ?? nextHabitEntryStatus(habitEntryStatusOf(current))

  return store.writeLocal({
    entityType: "habitEntry",
    entityId: current?.entityId ?? input.id ?? uuidV7(),
    op: "upsert",
    patch: {
      habitId: input.habitId,
      localDate: input.localDate,
      timeZone: input.timeZone,
      status,
      ...(input.visibility === undefined ? {} : { visibility: input.visibility })
    },
    // Re-logging a cleared day is an optimistic revive; the server confirms it
    // on the next push (or through the tombstone-repair path if it refuses).
    deletedAt: null,
    now,
    clientMutationId: input.clientMutationId
  })
}
