import { Array, Schema } from 'effect'

import {
  JALALI_MONTHS,
  type OccasionOccurrence,
  type OccasionSource,
  defaultVisibilityFor,
  formatJalaliDate,
  localizeDigits,
  nextOccasionOccurrence,
  occasionAdvanceReminderDate,
  occasionOccurrences,
  occasionPreparationTaskTitle,
  toJalaliDate,
  toJalaliFields,
} from '@tali/domain'
import type { LocalStore, MirrorRecord } from '@tali/sync-client'

import type { CalendarOccasionSource } from './calendar-data'

/**
 * The calendar's occasion lane and panel, ported from
 * `apps/web/src/lib/occasions/model.ts`.
 *
 * Everything derives from the IndexedDB mirror: the annual projection, the
 * advance-reminder date, the next occurrence and the one-tap preparation task
 * all reuse the shared domain builders, so the panel cannot disagree with the
 * server read model. Every write is a `writeLocal` call, so the mirror and the
 * outbox commit together and the sync engine carries the occasion.
 */

// MODEL

export const OccasionRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  originDate: Schema.String,
  timeZone: Schema.String,
  yearly: Schema.Boolean,
  advanceReminderDays: Schema.NullOr(Schema.Int),
  preparationTaskId: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  ownerId: Schema.NullOr(Schema.String),
  visibility: Schema.Literals(['private', 'shared']),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  version: Schema.Int,
  hasSyncError: Schema.Boolean,
})

export type OccasionRow = typeof OccasionRow.Type

export const OccasionDraft = Schema.Struct({
  title: Schema.String,
  originDate: Schema.String,
  timeZone: Schema.String,
  yearly: Schema.Boolean,
  advanceReminderDays: Schema.NullOr(Schema.Int),
})

export type OccasionDraft = typeof OccasionDraft.Type

// PROJECTION

const asNullableString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null

const asNullableInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null

export const toOccasionRow = (record: MirrorRecord): OccasionRow =>
  OccasionRow.make({
    id: record.entityId,
    title: typeof record.data.title === 'string' ? record.data.title : '',
    originDate:
      typeof record.data.originDate === 'string'
        ? record.data.originDate
        : record.updatedAt.slice(0, 10),
    timeZone:
      typeof record.data.timeZone === 'string' ? record.data.timeZone : 'UTC',
    yearly: record.data.yearly !== false,
    advanceReminderDays: asNullableInt(record.data.advanceReminderDays),
    preparationTaskId: asNullableString(record.data.preparationTaskId),
    color: asNullableString(record.data.color),
    ownerId: asNullableString(record.data.ownerId),
    visibility:
      record.data.visibility === 'private' ||
      record.data.visibility === 'shared'
        ? record.data.visibility
        : defaultVisibilityFor('occasion'),
    createdAt:
      typeof record.data.createdAt === 'string'
        ? record.data.createdAt
        : record.updatedAt,
    updatedAt: record.updatedAt,
    version: record.version,
    hasSyncError: record.syncError !== undefined,
  })

export const occasionRowsFromMirror = (
  records: ReadonlyArray<MirrorRecord>,
): ReadonlyArray<OccasionRow> => Array.map(records, toOccasionRow)

/** The structural shape the shared annual projection accepts. */
export const asOccasionSource = (row: OccasionRow): OccasionSource => ({
  id: row.id,
  title: row.title,
  color: row.color,
  originDate: row.originDate,
  timeZone: row.timeZone,
  yearly: row.yearly,
  advanceReminderDays: row.advanceReminderDays,
})

export const occasionSourceOf = (row: OccasionRow): CalendarOccasionSource => ({
  id: row.id,
  title: row.title,
  color: row.color,
  originDate: row.originDate,
  timeZone: row.timeZone,
  yearly: row.yearly,
  advanceReminderDays: row.advanceReminderDays,
})

export const occasionSourcesOf = (
  rows: ReadonlyArray<OccasionRow>,
): ReadonlyArray<CalendarOccasionSource> => Array.map(rows, occasionSourceOf)

// WRITES

/** Create an occasion locally; the sync push inserts it on the server. */
export const createOccasionInMirror = async (
  store: LocalStore,
  draft: OccasionDraft,
  id: string,
  now: string,
): Promise<string> => {
  const title = draft.title.trim()

  if (title === '') {
    throw new Error('an occasion needs a title')
  }

  await store.writeLocal({
    entityType: 'occasion',
    entityId: id,
    op: 'upsert',
    patch: {
      id,
      type: 'occasion',
      ownerId: store.userId,
      title,
      originDate: draft.originDate,
      timeZone: draft.timeZone,
      yearly: draft.yearly,
      advanceReminderDays: draft.advanceReminderDays,
      preparationTaskId: null,
      color: null,
      visibility: defaultVisibilityFor('occasion'),
      createdAt: now,
    },
    now,
  })

  return id
}

/** Only the editable, client-writable fields; absent means "leave it". */
export const OccasionEditPatch = Schema.Struct({
  title: Schema.optional(Schema.String),
  originDate: Schema.optional(Schema.String),
  yearly: Schema.optional(Schema.Boolean),
  advanceReminderDays: Schema.optional(Schema.NullOr(Schema.Int)),
})

export type OccasionEditPatch = typeof OccasionEditPatch.Type

export const updateOccasionInMirror = async (
  store: LocalStore,
  id: string,
  patch: OccasionEditPatch,
  now: string,
): Promise<void> => {
  const record: Record<string, unknown> = {}

  if (patch.title !== undefined) {
    const title = patch.title.trim()

    if (title === '') {
      throw new Error('an occasion needs a title')
    }

    record.title = title
  }

  if (patch.originDate !== undefined) {
    record.originDate = patch.originDate
  }

  if (patch.yearly !== undefined) {
    record.yearly = patch.yearly
  }

  if (patch.advanceReminderDays !== undefined) {
    record.advanceReminderDays = patch.advanceReminderDays
  }

  if (Reflect.ownKeys(record).length === 0) {
    return
  }

  await store.writeLocal({
    entityType: 'occasion',
    entityId: id,
    op: 'upsert',
    patch: record,
    now,
  })
}

export const deleteOccasionInMirror = async (
  store: LocalStore,
  id: string,
  now: string,
): Promise<void> => {
  await store.writeLocal({
    entityType: 'occasion',
    entityId: id,
    op: 'delete',
    patch: {},
    now,
  })
}

/**
 * One-tap preparation task.
 *
 * The task is a normal mirrored task row, so it appears on `/today` and
 * `/tasks` immediately and syncs like any other task. The occasion's
 * `preparationTaskId` links it so a second tap is a no-op while the task is
 * live.
 *
 * The link is written **first**: if the second (task) write is interrupted,
 * the occasion points at a task that does not exist, and the next tap notices
 * the missing task, creates it and replaces the stale link. Writing the task
 * first would leave an unlinked orphan task that no later tap can find.
 */
export const prepareOccasionTaskInMirror = async (
  store: LocalStore,
  occasion: OccasionRow,
  today: string,
  taskId: string,
  now: string,
): Promise<Readonly<{ taskId: string; created: boolean }>> => {
  if (occasion.preparationTaskId !== null) {
    const linked = await store.get('task', occasion.preparationTaskId)

    if (linked !== undefined && linked.deletedAt === null) {
      return { taskId: linked.entityId, created: false }
    }
  }

  const occurrence = nextOccasionOccurrence(asOccasionSource(occasion), today)

  if (occurrence === null) {
    throw new Error('this occasion has no upcoming occurrence')
  }

  const dueDate =
    occasionAdvanceReminderDate(asOccasionSource(occasion), occurrence.date) ??
    occurrence.date

  await store.writeLocal({
    entityType: 'occasion',
    entityId: occasion.id,
    op: 'upsert',
    patch: { preparationTaskId: taskId },
    now,
  })
  await store.writeLocal({
    entityType: 'task',
    entityId: taskId,
    op: 'upsert',
    patch: {
      id: taskId,
      type: 'task',
      title: occasionPreparationTaskTitle(occasion.title),
      description: null,
      status: 'todo',
      priority: 'medium',
      dueAt: null,
      dueDate,
      timeZone: occasion.timeZone,
      projectId: null,
      tagIds: [],
      color: occasion.color,
      visibility: occasion.visibility,
      createdAt: now,
    },
    now,
  })

  return { taskId, created: true }
}

// PROJECTION HELPERS

/** The next occurrence of each occasion, `null` for a passed one-off date. */
export const upcomingOccasions = (
  occasions: ReadonlyArray<OccasionRow>,
  today: string,
): ReadonlyArray<
  Readonly<{
    occasion: OccasionRow
    occurrence: OccasionOccurrence | null
  }>
> =>
  occasions
    .map(occasion => ({
      occasion,
      occurrence: nextOccasionOccurrence(asOccasionSource(occasion), today),
    }))
    .sort((left, right) => {
      const leftDate = left.occurrence?.date ?? '9999-12-31'
      const rightDate = right.occurrence?.date ?? '9999-12-31'

      return (
        leftDate.localeCompare(rightDate) ||
        left.occasion.title.localeCompare(right.occasion.title, 'fa')
      )
    })

/** The occurrences painted in a window, from wire/read-model source rows. */
export const monthOccasionsFromSources = (
  sources: ReadonlyArray<OccasionSource>,
  from: string,
  to: string,
): ReadonlyArray<OccasionOccurrence> =>
  occasionOccurrences({
    occasions: sources,
    range: { from, to },
  })

/** Group occurrences by their local date for the month grid. */
export const occasionsByDate = (
  occurrences: ReadonlyArray<OccasionOccurrence>,
): ReadonlyMap<string, ReadonlyArray<OccasionOccurrence>> => {
  const map = new Map<string, Array<OccasionOccurrence>>()

  for (const occurrence of occurrences) {
    const bucket = map.get(occurrence.date) ?? []
    bucket.push(occurrence)
    map.set(occurrence.date, bucket)
  }

  return map
}

// DISPLAY

export const ADVANCE_OPTIONS: ReadonlyArray<
  Readonly<{ value: string; label: string }>
> = [
  { value: '', label: 'بدون یادآوری' },
  { value: '0', label: 'همان روز' },
  { value: '1', label: '۱ روز قبل' },
  { value: '3', label: '۳ روز قبل' },
  { value: '7', label: '۷ روز قبل' },
  { value: '14', label: '۱۴ روز قبل' },
  { value: '30', label: '۳۰ روز قبل' },
]

export const advanceLabel = (days: number | null): string =>
  days === null
    ? 'بدون یادآوری پیش از موعد'
    : days === 0
      ? 'یادآوری همان روز'
      : `یادآوری ${days.toLocaleString('fa-IR')} روز قبل`

export const GREGORIAN_MONTHS = [
  'ژانویه',
  'فوریه',
  'مارس',
  'آوریل',
  'مه',
  'ژوئن',
  'ژوئیه',
  'اوت',
  'سپتامبر',
  'اکتبر',
  'نوامبر',
  'دسامبر',
] as const

export const formatGregorianDate = (
  date: Readonly<{ year: number; month: number; day: number }>,
  digits: 'persian' | 'latin',
): string =>
  `${localizeDigits(date.day, digits)} ${
    GREGORIAN_MONTHS[date.month - 1] ?? ''
  } ${localizeDigits(date.year, digits)}`

/** "۱۲ فروردین ۱۴۰۵ · ۱ آوریل ۲۰۲۶" — both calendars, one line. */
export const formatOccasionDate = (
  occurrence: Readonly<{
    date: string
    gregorian: Readonly<{ year: number; month: number; day: number }>
  }>,
  digits: 'persian' | 'latin',
): string =>
  `${formatJalaliDate(toJalaliDate(occurrence.date), {
    digits,
    style: 'medium',
  })} · ${formatGregorianDate(occurrence.gregorian, digits)}`

const formatJalaliShort = (
  date: string,
  digits: 'persian' | 'latin',
): string => {
  const fields = toJalaliFields(toJalaliDate(date))

  return `${localizeDigits(fields.day, digits)} ${
    JALALI_MONTHS[fields.month - 1] ?? ''
  } ${localizeDigits(fields.year, digits)}`
}

/** "۷ روز قبل — ۵ فروردین ۱۴۰۵" for the reminder line. */
export const formatAdvanceReminder = (
  occurrence: Readonly<{
    date: string
    advanceReminderDate: string | null
  }>,
  digits: 'persian' | 'latin',
): string | null => {
  if (occurrence.advanceReminderDate === null) {
    return null
  }

  const days =
    occurrence.advanceReminderDate === occurrence.date
      ? 'همان روز'
      : `${localizeDigits(
          Math.round(
            (Date.parse(`${occurrence.date}T00:00:00Z`) -
              Date.parse(`${occurrence.advanceReminderDate}T00:00:00Z`)) /
              86_400_000,
          ),
          digits,
        )} روز قبل`

  return `${days} — ${formatJalaliShort(occurrence.advanceReminderDate, digits)}`
}
