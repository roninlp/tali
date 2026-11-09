import { Array, Option, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import {
  DEFAULT_TIME_ZONE,
  JALALI_MONTHS,
  JALALI_WEEKDAYS,
  addJalaliDays,
  formatJalaliDate,
  jalaliWeek,
  localizeDigits,
  moveDashboardSection,
  normalizeDashboardSectionOrder,
  taskBucketBounds,
  taskBucketOf,
  toIsoDate,
  toJalaliDate,
  toJalaliFields,
} from '@tali/domain'
import type { Digits, TaskBucketBounds, WeekStart } from '@tali/domain'

import type { TodayReadModel } from '../lib/today-api'
import type { NoteRow, TaskRow } from '../mirror'
import {
  noteKey,
  noteRowFromServer,
  sortNotes,
  sortTasks,
  taskKey,
  taskRowFromServer,
} from '../mirror'

/**
 * The Today dashboard's pure client model, ported from
 * `apps/web/src/lib/today/model.ts` and the formatting half of
 * `apps/web/src/routes/today.tsx`.
 *
 * Two inputs feed one view:
 *
 * - **server** — the `GET /today` read model, when the device is online with an
 *   empty outbox;
 * - **mirror** — the IndexedDB rows, aggregated with the same domain bucketing
 *   the server uses, so an offline boot or an API outage still paints the
 *   daily picture.
 *
 * Both paths return the same `TodayView`, so the renderer never branches on
 * connectivity. A pending local write is overlaid on the server model until the
 * outbox drains and a fresh 200 replaces it; dirty keys keep an acknowledged
 * write from flashing back when a stale read model arrives.
 */

export const DashboardSection = Schema.Literals([
  'tasks',
  'events',
  'reminders',
  'habits',
  'notes',
])

export type DashboardSection = typeof DashboardSection.Type

export const SECTION_TITLES: Readonly<Record<DashboardSection, string>> = {
  tasks: 'کارهای امروز',
  events: 'رویدادها',
  reminders: 'یادآورها',
  habits: 'عادت‌ها',
  notes: 'یادداشت‌های پین‌شده',
}

export const DashboardSectionMove = Schema.Literals(['up', 'down'])

export type DashboardSectionMove = typeof DashboardSectionMove.Type

export const HabitWindow = Schema.Literals([7, 30, 90])

export type HabitWindow = typeof HabitWindow.Type

export const TodayFetchState = defineTaggedUnion({
  Idle: {},
  Ready: {},
  Offline: {},
  Error: {},
})

export type TodayFetchState = typeof TodayFetchState.Type

export const TodaySource = Schema.Literals(['server', 'mirror'])

export type TodaySource = typeof TodaySource.Type

export interface TodayCounts {
  readonly tasks: number
  readonly overdue: number
  readonly notes: number
}

export interface TodayView {
  readonly today: string
  readonly tomorrow: string
  readonly timeZone: string
  readonly tasks: ReadonlyArray<TaskRow>
  readonly notes: ReadonlyArray<NoteRow>
  readonly counts: TodayCounts
  readonly source: TodaySource
}

export const sectionOrderOf = (
  order: ReadonlyArray<string>,
): ReadonlyArray<DashboardSection> => normalizeDashboardSectionOrder(order)

export const moveSection = (
  order: ReadonlyArray<string>,
  section: DashboardSection,
  direction: DashboardSectionMove,
): ReadonlyArray<DashboardSection> =>
  moveDashboardSection(order, section, direction)

export const validTimeZone = (timeZone: string): string => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })

    return timeZone
  } catch {
    return DEFAULT_TIME_ZONE
  }
}

export const boundsFor = (timeZone: string, now: number): TaskBucketBounds =>
  taskBucketBounds(validTimeZone(timeZone), new Date(now))

const placementOf = (task: TaskRow, bounds: TaskBucketBounds) =>
  taskBucketOf(
    { dueAt: task.dueAt, dueDate: task.dueDate, status: task.status },
    bounds,
  )

export const isOverdue = (task: TaskRow, bounds: TaskBucketBounds): boolean =>
  placementOf(task, bounds) === 'overdue'

const isTodayTask = (task: TaskRow, bounds: TaskBucketBounds): boolean => {
  const placement = placementOf(task, bounds)

  return placement === 'overdue' || placement === 'today'
}

const countsOf = (
  tasks: ReadonlyArray<TaskRow>,
  notes: ReadonlyArray<NoteRow>,
  bounds: TaskBucketBounds,
): TodayCounts => ({
  tasks: Array.length(tasks),
  overdue: Array.filter(tasks, task => isOverdue(task, bounds)).length,
  notes: Array.length(notes),
})

export const fromServerToday = (model: TodayReadModel): TodayView => {
  const tasks = Array.map(model.tasks, taskRowFromServer)

  const notes = Array.filter(
    Array.map(model.notes, noteRowFromServer),
    note => note.isPinned && !note.isArchived,
  )

  return {
    today: model.today,
    tomorrow: model.tomorrow,
    timeZone: model.timeZone,
    tasks,
    notes: sortNotes(notes),
    counts: model.counts,
    source: 'server',
  }
}

export const fromMirrorToday = (
  mirror: {
    readonly tasks: ReadonlyArray<TaskRow>
    readonly notes: ReadonlyArray<NoteRow>
  },
  timeZone: string,
  now: number,
): TodayView => {
  const zone = validTimeZone(timeZone)
  const bounds = boundsFor(zone, now)

  const tasks = Array.filter(
    mirror.tasks,
    task => task.status !== 'done' && isTodayTask(task, bounds),
  )

  const notes = Array.filter(
    mirror.notes,
    note => note.isPinned && !note.isArchived,
  )

  return {
    today: bounds.today,
    tomorrow: bounds.tomorrow,
    timeZone: zone,
    tasks: sortTasks(tasks),
    notes: sortNotes(notes),
    counts: countsOf(tasks, notes, bounds),
    source: 'mirror',
  }
}

/**
 * Overlay unsent local writes on the read model.
 *
 * A local completion/move/quick-add is visible in the mirror immediately but
 * has not reached the server, so the read model would otherwise still show the
 * old row (and blanking the whole model would hide tasks the mirror has never
 * seen). Merging the pending mirror row over its server row keeps the rest of
 * the picture intact until the outbox drains and the ETag refreshes.
 */
export const overlayPendingToday = (
  base: TodayView,
  mirror: {
    readonly tasks: ReadonlyArray<TaskRow>
    readonly notes: ReadonlyArray<NoteRow>
  },
  pending: ReadonlyArray<string>,
  dirty: ReadonlyArray<string>,
  now: number,
): TodayView => {
  const bounds = boundsFor(base.timeZone, now)
  const pendingSet = new Set([...pending, ...dirty])
  const serverTaskIds = new Set<string>()
  const mirrorTasks = new Map<string, TaskRow>()
  const serverNoteIds = new Set<string>()
  const mirrorNotes = new Map<string, NoteRow>()

  base.tasks.forEach(task => {
    serverTaskIds.add(task.id)
  })
  mirror.tasks.forEach(task => {
    mirrorTasks.set(task.id, task)
  })
  base.notes.forEach(note => {
    serverNoteIds.add(note.id)
  })
  mirror.notes.forEach(note => {
    mirrorNotes.set(note.id, note)
  })

  const tasks = Array.filter(
    [
      ...Array.map(base.tasks, task =>
        pendingSet.has(taskKey(task.id))
          ? (mirrorTasks.get(task.id) ?? task)
          : task,
      ),
      ...Array.flatMap(mirror.tasks, task =>
        serverTaskIds.has(task.id) || !pendingSet.has(taskKey(task.id))
          ? []
          : [task],
      ),
    ],
    task => task.status !== 'done' && isTodayTask(task, bounds),
  )

  const notes = [
    ...Array.map(base.notes, note =>
      pendingSet.has(noteKey(note.id))
        ? (mirrorNotes.get(note.id) ?? note)
        : note,
    ),
    ...Array.flatMap(mirror.notes, note =>
      serverNoteIds.has(note.id) || !pendingSet.has(noteKey(note.id))
        ? []
        : [note],
    ),
  ]

  const pinnedNotes = Array.filter(
    notes,
    note => note.isPinned && !note.isArchived,
  )

  return {
    today: base.today,
    tomorrow: base.tomorrow,
    timeZone: base.timeZone,
    tasks: sortTasks(tasks),
    notes: sortNotes(pinnedNotes),
    counts: countsOf(tasks, pinnedNotes, bounds),
    source: 'server',
  }
}

export type ViewInput = Readonly<{
  maybeServer: Option.Option<TodayReadModel>
  mirror: {
    readonly tasks: ReadonlyArray<TaskRow>
    readonly notes: ReadonlyArray<NoteRow>
  }
  pendingKeys: ReadonlyArray<string>
  dirtyKeys: ReadonlyArray<string>
  isOnline: boolean
  timeZone: string
  now: number
}>

/** Paint the day: the server model when it is current, otherwise the mirror. */
export const todayView = (input: ViewInput): TodayView => {
  const local = fromMirrorToday(input.mirror, input.timeZone, input.now)

  return Option.match(input.maybeServer, {
    onNone: () => local,
    onSome: server => {
      const isCurrent = input.isOnline && server.today === local.today

      return isCurrent
        ? overlayPendingToday(
            fromServerToday(server),
            input.mirror,
            input.pendingKeys,
            input.dirtyKeys,
            input.now,
          )
        : local
    },
  })
}

// ── Dates and copy ───────────────────────────────────────────────────────

export interface WeekDay {
  readonly key: string
  readonly shortWeekday: string
  readonly day: string
  readonly label: string
  readonly isToday: boolean
}

/** The seven Jalali days of today's week, honoring the saved preferences. */
export const weekDaysFor = (
  today: string,
  weekStart: WeekStart,
  digits: Digits,
): ReadonlyArray<WeekDay> => {
  const date = toJalaliDate(today)

  return Array.map(jalaliWeek(date, weekStart), day => {
    const fields = toJalaliFields(day)

    const weekday =
      JALALI_WEEKDAYS[day.withCalendar('iso8601').dayOfWeek - 1] ?? ''

    const month = JALALI_MONTHS[fields.month - 1] ?? ''
    const localizedDay = localizeDigits(fields.day, digits)

    return {
      key: day.withCalendar('iso8601').toString(),
      shortWeekday: weekday.charAt(0),
      day: localizedDay,
      label: `${weekday} ${localizedDay} ${month}`,
      isToday: day.equals(date),
    }
  })
}

export const formatTodayHeading = (today: string, digits: Digits): string =>
  formatJalaliDate(toJalaliDate(today), { digits })

const formatLocalDate = (date: string, digits: Digits): string =>
  formatJalaliDate(toJalaliDate(date), { style: 'short', digits })

export const shiftLocalDate = (date: string, days: number): string =>
  toIsoDate(addJalaliDays(toJalaliDate(date), days))

/** A short, calm label for the due chip. Overdue is quiet amber, never an alert. */
export const dueLabel = (
  task: TaskRow,
  bounds: TaskBucketBounds,
  digits: Digits,
): string => {
  if (task.dueDate === null && task.dueAt === null) {
    return 'بدون تاریخ'
  }

  if (task.dueDate === bounds.today) {
    return 'امروز'
  }

  if (task.dueDate === bounds.tomorrow) {
    return 'فردا'
  }

  if (task.dueDate !== null) {
    const label = formatLocalDate(task.dueDate, digits)

    return task.dueDate < bounds.today ? `عقب‌افتاده · ${label}` : label
  }

  return new Intl.DateTimeFormat('fa-IR', {
    day: 'numeric',
    month: 'short',
    timeZone: bounds.timeZone,
  }).format(new Date(task.dueAt ?? ''))
}

export interface ZoneTime {
  readonly hour: number
  readonly minute: number
}

/** Resolve a UTC instant's wall clock in the household's zone. */
export const zoneTime = (iso: string, timeZone: string): ZoneTime => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))

  const read = (type: string): number =>
    Number(parts.find(part => part.type === type)?.value ?? '0')

  return { hour: read('hour'), minute: read('minute') }
}

export const zoneMinutes = (iso: string, timeZone: string): number => {
  const { hour, minute } = zoneTime(iso, timeZone)

  return hour * 60 + minute
}

export const timeLabel = (
  iso: string,
  timeZone: string,
  digits: Digits,
): string => {
  const { hour, minute } = zoneTime(iso, timeZone)

  return localizeDigits(
    `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    digits,
  )
}

export const STRIP_START = 6 * 60
export const STRIP_END = 24 * 60
export const STRIP_TICKS: ReadonlyArray<number> = [6, 9, 12, 15, 18, 21]

export const stripPercent = (minutes: number): number =>
  Math.min(
    100,
    Math.max(0, ((minutes - STRIP_START) / (STRIP_END - STRIP_START)) * 100),
  )

/** Timed work reads top-to-bottom by the clock; all-day work follows it. */
export const orderedTasks = (
  tasks: ReadonlyArray<TaskRow>,
  timeZone: string,
): ReadonlyArray<TaskRow> =>
  [...tasks].sort((left, right) => {
    const leftMinutes =
      left.dueAt === null ? null : zoneMinutes(left.dueAt, timeZone)

    const rightMinutes =
      right.dueAt === null ? null : zoneMinutes(right.dueAt, timeZone)

    if (leftMinutes === null && rightMinutes === null) {
      return 0
    }

    if (leftMinutes === null) {
      return 1
    }

    if (rightMinutes === null) {
      return -1
    }

    return leftMinutes < rightMinutes ? -1 : leftMinutes > rightMinutes ? 1 : 0
  })

export const timedTasks = (
  tasks: ReadonlyArray<TaskRow>,
  timeZone: string,
): ReadonlyArray<TaskRow> =>
  Array.filter(orderedTasks(tasks, timeZone), task => task.dueAt !== null)

export const nextTimedTask = (
  tasks: ReadonlyArray<TaskRow>,
  timeZone: string,
  now: number,
): TaskRow | undefined => {
  const deadline = zoneMinutes(new Date(now).toISOString(), timeZone)

  return Array.findFirst(
    timedTasks(tasks, timeZone),
    task => zoneMinutes(task.dueAt ?? '', timeZone) >= deadline,
  ).pipe(Option.getOrUndefined)
}

export const sourceText = (
  isOnline: boolean,
  fetchState: TodayFetchState,
): string => {
  if (!isOnline) {
    return 'آفلاین — نمایش از حافظهٔ محلی'
  }

  return TodayFetchState.match(fetchState, {
    Idle: () => 'برخط',
    Ready: () => 'برخط',
    Offline: () => 'آفلاین — نمایش از حافظهٔ محلی',
    Error: () => 'ارتباط با سرور برقرار نشد؛ نمایش از حافظهٔ محلی',
  })
}

export const isOfflineSource = (
  isOnline: boolean,
  fetchState: TodayFetchState,
): boolean =>
  !isOnline ||
  TodayFetchState.match(fetchState, {
    Idle: () => false,
    Ready: () => false,
    Offline: () => true,
    Error: () => true,
  })

export const DEFAULT_TODAY_TIME_ZONE = DEFAULT_TIME_ZONE
