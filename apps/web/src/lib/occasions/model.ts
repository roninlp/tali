import {
  formatJalaliDate,
  JALALI_MONTHS,
  localizeDigits,
  occasionAdvanceReminderDate,
  nextOccasionOccurrence,
  occasionOccurrences,
  occasionPreparationTaskTitle,
  toJalaliDate,
  toJalaliFields,
  uuidV7,
  type Digits,
  type LocalDate,
  type OccasionOccurrence
} from "@tali/domain"
import type { LocalStore, MirrorRecord } from "../local-store"

/**
 * The `/calendar` occasion client model (ticket #59; FR-CAL-02).
 *
 * Everything is derived from the IndexedDB mirror, exactly like the task lanes
 * (#37/#43): the annual projection, the advance-reminder date and the next
 * occurrence all come from the shared `packages/domain` builders, so the
 * offline panel cannot disagree with the server's read model. Writes are
 * `writeLocal` calls, so the mirror and the outbox commit together and the
 * regular sync engine carries the occasion (`occasion` is in the #34 registry).
 */

export interface OccasionRow {
  readonly id: string
  readonly title: string
  readonly originDate: string
  readonly timeZone: string
  readonly yearly: boolean
  readonly advanceReminderDays: number | null
  readonly preparationTaskId: string | null
  readonly color: string | null
  readonly visibility: "private" | "shared"
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null

const asNullableInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null

export const toOccasionRow = (record: MirrorRecord): OccasionRow => ({
  id: record.entityId,
  title: typeof record.data.title === "string" ? record.data.title : "",
  originDate:
    typeof record.data.originDate === "string" ? record.data.originDate : record.updatedAt.slice(0, 10),
  timeZone: typeof record.data.timeZone === "string" ? record.data.timeZone : "UTC",
  yearly: record.data.yearly !== false,
  advanceReminderDays: asNullableInt(record.data.advanceReminderDays),
  preparationTaskId: asNullableString(record.data.preparationTaskId),
  color: asNullableString(record.data.color),
  visibility: record.data.visibility === "private" ? "private" : "shared",
  createdAt:
    typeof record.data.createdAt === "string" ? record.data.createdAt : record.updatedAt,
  updatedAt: record.updatedAt,
  version: record.version
})

/** The structural shape the shared projection accepts. */
export const asOccasionSource = (occasion: OccasionRow) => ({
  id: occasion.id,
  title: occasion.title,
  color: occasion.color,
  originDate: occasion.originDate,
  timeZone: occasion.timeZone,
  yearly: occasion.yearly,
  advanceReminderDays: occasion.advanceReminderDays
})

export interface OccasionDraft {
  readonly title: string
  readonly originDate: string
  readonly timeZone: string
  readonly yearly: boolean
  readonly advanceReminderDays: number | null
}

/** Create an occasion locally; the sync push inserts it on the server. */
export const createOccasionInMirror = async (
  store: LocalStore,
  draft: OccasionDraft,
  now: string = new Date().toISOString()
): Promise<string> => {
  const title = draft.title.trim()
  if (title === "") throw new Error("an occasion needs a title")
  const id = uuidV7()
  await store.writeLocal({
    entityType: "occasion",
    entityId: id,
    op: "upsert",
    patch: {
      id,
      type: "occasion",
      title,
      originDate: draft.originDate,
      timeZone: draft.timeZone,
      yearly: draft.yearly,
      advanceReminderDays: draft.advanceReminderDays,
      preparationTaskId: null,
      color: null,
      visibility: "shared",
      createdAt: now
    },
    now
  })
  return id
}

/** Only the editable, client-writable fields; absent means "leave it". */
export interface OccasionEditPatch {
  readonly title?: string
  readonly originDate?: string
  readonly yearly?: boolean
  readonly advanceReminderDays?: number | null
}

export const updateOccasionInMirror = async (
  store: LocalStore,
  id: string,
  patch: OccasionEditPatch,
  now: string = new Date().toISOString()
): Promise<void> => {
  const record: Record<string, unknown> = {}
  if (patch.title !== undefined) {
    const title = patch.title.trim()
    if (title === "") throw new Error("an occasion needs a title")
    record.title = title
  }
  if (patch.originDate !== undefined) record.originDate = patch.originDate
  if (patch.yearly !== undefined) record.yearly = patch.yearly
  if (patch.advanceReminderDays !== undefined) {
    record.advanceReminderDays = patch.advanceReminderDays
  }
  if (Object.keys(record).length === 0) return
  await store.writeLocal({ entityType: "occasion", entityId: id, op: "upsert", patch: record, now })
}

export const deleteOccasionInMirror = async (
  store: LocalStore,
  id: string,
  now: string = new Date().toISOString()
): Promise<void> => {
  await store.writeLocal({ entityType: "occasion", entityId: id, op: "delete", patch: {}, now })
}

/** The next occurrence of each occasion, `null` for a passed one-off date. */
export const upcomingOccasions = (
  occasions: ReadonlyArray<OccasionRow>,
  today: string
): ReadonlyArray<{
  readonly occasion: OccasionRow
  readonly occurrence: OccasionOccurrence | null
}> =>
  occasions
    .map((occasion) => ({
      occasion,
      occurrence: nextOccasionOccurrence(asOccasionSource(occasion), today)
    }))
    .sort((a, b) => {
      const left = a.occurrence?.date ?? "9999-12-31"
      const right = b.occurrence?.date ?? "9999-12-31"
      return left.localeCompare(right) || a.occasion.title.localeCompare(b.occasion.title, "fa")
    })

/** The occurrences painted in a month window (inclusive bounds). */
export const monthOccasions = (
  occasions: ReadonlyArray<OccasionRow>,
  from: string,
  to: string
): ReadonlyArray<OccasionOccurrence> =>
  occasionOccurrences({
    occasions: occasions.map(asOccasionSource),
    range: { from: from as LocalDate, to: to as LocalDate }
  })

/** Group occurrences by their local date for the month grid. */
export const occasionsByDate = (
  occurrences: ReadonlyArray<OccasionOccurrence>
): ReadonlyMap<string, ReadonlyArray<OccasionOccurrence>> => {
  const map = new Map<string, Array<OccasionOccurrence>>()
  for (const occurrence of occurrences) {
    const bucket = map.get(occurrence.date) ?? []
    bucket.push(occurrence)
    map.set(occurrence.date, bucket)
  }
  return map
}

/** The advance-reminder date of an occurrence (already on the projection). */
export const reminderDateOf = (occurrence: OccasionOccurrence): string | null =>
  occurrence.advanceReminderDate

/**
 * One-tap preparation task.
 *
 * The task is a normal mirrored task row, so it appears on `/today`/`/tasks`
 * immediately and syncs like any other task. The occasion's
 * `preparationTaskId` links it so a second tap is a no-op while the task is
 * live.
 *
 * Two `writeLocal` calls are used because the store commits one row at a time,
 * and the **link is written first**. The order matters: if the second (task)
 * write is interrupted, the occasion points at a task that does not exist, and
 * the next tap notices the missing task, creates it and replaces the stale link
 * — so the interrupted path self-heals. Writing the task first would instead
 * leave an unlinked orphan task that no later tap can find, which is the one
 * outcome that never heals.
 */
export const prepareOccasionTaskInMirror = async (
  store: LocalStore,
  occasion: OccasionRow,
  today: string,
  now: string = new Date().toISOString()
): Promise<{ readonly taskId: string; readonly created: boolean }> => {
  if (occasion.preparationTaskId !== null) {
    const linked = await store.get("task", occasion.preparationTaskId)
    if (linked !== undefined && linked.deletedAt === null) {
      return { taskId: linked.entityId, created: false }
    }
  }

  const occurrence = nextOccasionOccurrence(asOccasionSource(occasion), today)
  if (occurrence === null) throw new Error("this occasion has no upcoming occurrence")

  const dueDate =
    occasionAdvanceReminderDate(asOccasionSource(occasion), occurrence.date) ?? occurrence.date
  const taskId = uuidV7()
  // Link first: an interrupted second write leaves a stale link the next tap
  // repairs, never an orphan task (see the doc comment above).
  await store.writeLocal({
    entityType: "occasion",
    entityId: occasion.id,
    op: "upsert",
    patch: { preparationTaskId: taskId },
    now
  })
  await store.writeLocal({
    entityType: "task",
    entityId: taskId,
    op: "upsert",
    patch: {
      id: taskId,
      type: "task",
      title: occasionPreparationTaskTitle(occasion.title),
      description: null,
      status: "todo",
      priority: "medium",
      dueAt: null,
      dueDate,
      timeZone: occasion.timeZone,
      projectId: null,
      tagIds: [],
      color: occasion.color,
      visibility: occasion.visibility,
      createdAt: now
    },
    now
  })
  return { taskId, created: true }
}

// ── Display helpers ──────────────────────────────────────────────────────

export const GREGORIAN_MONTHS = [
  "ژانویه",
  "فوریه",
  "مارس",
  "آوریل",
  "مه",
  "ژوئن",
  "ژوئیه",
  "اوت",
  "سپتامبر",
  "اکتبر",
  "نوامبر",
  "دسامبر"
] as const

export const formatGregorianDate = (
  date: OccasionOccurrence["gregorian"],
  digits: Digits
): string =>
  `${localizeDigits(date.day, digits)} ${GREGORIAN_MONTHS[date.month - 1] ?? ""} ${localizeDigits(date.year, digits)}`

/** "۱۲ فروردین ۱۴۰۵ · ۱ آوریل ۲۰۲۶" — both calendars, one line. */
export const formatOccasionDate = (
  occurrence: OccasionOccurrence,
  digits: Digits
): string =>
  `${formatJalaliDate(toJalaliDate(occurrence.date), { digits, style: "medium" })} · ${
    formatGregorianDate(occurrence.gregorian, digits)
  }`

/** "۷ روز قبل — ۵ فروردین ۱۴۰۵" for the reminder line. */
export const formatAdvanceReminder = (
  occurrence: OccasionOccurrence,
  digits: Digits
): string | null => {
  if (occurrence.advanceReminderDate === null) return null
  const days = occurrence.advanceReminderDate === occurrence.date
    ? "همان روز"
    : `${localizeDigits(
      Math.round(
        (Date.parse(`${occurrence.date}T00:00:00Z`) -
          Date.parse(`${occurrence.advanceReminderDate}T00:00:00Z`)) /
          86_400_000
      ),
      digits
    )} روز قبل`
  return `${days} — ${formatJalaliShort(occurrence.advanceReminderDate, digits)}`
}

const formatJalaliShort = (date: string, digits: Digits): string => {
  const fields = toJalaliFields(toJalaliDate(date))
  return `${localizeDigits(fields.day, digits)} ${JALALI_MONTHS[fields.month - 1] ?? ""} ${
    localizeDigits(fields.year, digits)
  }`
}