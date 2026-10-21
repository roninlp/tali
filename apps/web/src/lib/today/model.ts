import {
  taskBucketBounds,
  taskBucketOf,
  type Note,
  type Task,
  type TodayCounts,
  type TodayEmpty,
  type TodayReadModel
} from "@tali/domain"
import type { MirrorRecord } from "../local-store"
import { noteToServerRow, toNoteRow, type NoteRow } from "../notes/mirror"
import { compareTasks, toTaskRow, type TaskRow } from "../tasks/model"

/**
 * The `/today` client model (ticket #42).
 *
 * Two inputs feed the same view:
 *
 * - **server** — the `GET /today` read model when the device is online with an
 *   empty outbox (the #36/#40 services already applied household/private
 *   authorization);
 * - **mirror** — the IndexedDB rows, aggregated with the same domain bucketing
 *   the server uses, so an offline boot or an API outage still paints the
 *   daily picture and inline writes stay local-first.
 *
 * Both paths return the same `TodayView`, so the renderer never branches on
 * connectivity. Section order is *not* taken from this view: it comes from the
 * preferences store (#35), which is cached for offline boot and re-renders
 * live after a settings save.
 */

export type TodaySource = "server" | "mirror"

export interface TodayView {
  readonly today: string
  readonly tomorrow: string
  readonly timeZone: string
  readonly tasks: ReadonlyArray<TaskRow>
  readonly notes: ReadonlyArray<NoteRow>
  readonly counts: TodayCounts
  readonly empty: TodayEmpty
  readonly source: TodaySource
}

/** Project a server `Task` into the row shape the task UI already understands. */
export const taskRowFromTask = (task: Task): TaskRow => ({
  id: task.id,
  title: task.title,
  description: task.description,
  status: task.status,
  priority: task.priority,
  dueDate: task.dueDate,
  dueAt: task.dueAt,
  timeZone: task.timeZone,
  projectId: task.projectId,
  tagIds: task.tagIds,
  startedAt: task.startedAt,
  completedAt: task.completedAt,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  version: task.version
})

/** Project a server `Note` into the note list row (same projection as #40). */
export const noteRowFromNote = (note: Note): NoteRow =>
  toNoteRow(noteToServerRow(note))

export const fromServerToday = (model: TodayReadModel): TodayView => ({
  today: model.today,
  tomorrow: model.tomorrow,
  timeZone: model.timeZone,
  tasks: model.tasks.map(taskRowFromTask).filter((task) => task.status !== "done"),
  notes: model.notes.map(noteRowFromNote),
  counts: model.counts,
  empty: model.empty,
  source: "server"
})

const pendingKey = (entityType: string, entityId: string): string =>
  `${entityType}\u0000${entityId}`

const taskRecord = (task: Task | TaskRow): MirrorRecord => {
  const { id, ...data } = task
  return {
    entityType: "task",
    entityId: id,
    version: task.version,
    updatedAt: task.updatedAt,
    deletedAt: null,
    data: { id, ...data } as Record<string, unknown>
  }
}

const noteRecord = (note: Note | NoteRow): MirrorRecord => {
  if ("data" in note) {
    return {
      entityType: "note",
      entityId: note.id,
      version: note.version,
      updatedAt: note.updatedAt,
      deletedAt: note.deletedAt,
      data: note.data
    }
  }
  const { id, ...rest } = note
  return {
    entityType: "note",
    entityId: id,
    version: note.version,
    updatedAt: note.updatedAt,
    deletedAt: note.deletedAt,
    data: { id, ...rest } as Record<string, unknown>
  }
}

/**
 * Overlay unsent local writes on the read model.
 *
 * A local completion/move/quick-add is visible in the mirror immediately but
 * has not reached the server, so the read model would otherwise still show the
 * old row (and blanking the whole model would hide tasks the mirror has never
 * seen). Merging the pending mirror patch over its server row keeps the rest of
 * the picture intact until the outbox drains and the ETag refreshes.
 */
export const overlayPendingToday = (
  base: TodayView,
  input: {
    readonly tasks: ReadonlyArray<MirrorRecord>
    readonly notes: ReadonlyArray<MirrorRecord>
    readonly pending: ReadonlySet<string>
    readonly timeZone: string
    readonly now: string
  }
): TodayView => {
  const bounds = taskBucketBounds(input.timeZone, input.now)

  const serverTasks = new Map<string, MirrorRecord>()
  for (const task of base.tasks) {
    serverTasks.set(task.id, taskRecord(task))
  }
  const mirrorTasks = new Map(
    input.tasks.map((record) => [record.entityId, record] as const)
  )

  const tasks: Array<TaskRow> = []
  for (const [id, record] of serverTasks) {
    const pending = input.pending.has(pendingKey("task", id))
    const mirror = mirrorTasks.get(id)
    const next = pending && mirror !== undefined
      ? toTaskRow({ ...record, data: { ...record.data, ...mirror.data } })
      : toTaskRow(record)
    if (next.status === "done") continue
    const bucket = taskBucketOf(
      { dueAt: next.dueAt, dueDate: next.dueDate, status: next.status },
      bounds
    )
    if (bucket === "overdue" || bucket === "today") tasks.push(next)
  }
  for (const [id, mirror] of mirrorTasks) {
    if (serverTasks.has(id) || !input.pending.has(pendingKey("task", id))) continue
    const next = toTaskRow(mirror)
    if (next.status === "done") continue
    const bucket = taskBucketOf(
      { dueAt: next.dueAt, dueDate: next.dueDate, status: next.status },
      bounds
    )
    if (bucket === "overdue" || bucket === "today") tasks.push(next)
  }
  tasks.sort((a, b) => compareTasks(a, b, { by: "dueDate", direction: "asc" }))

  const serverNotes = new Map<string, MirrorRecord>()
  for (const note of base.notes) serverNotes.set(note.id, noteRecord(note))
  const mirrorNotes = new Map(
    input.notes.map((record) => [record.entityId, record] as const)
  )
  const notes: Array<NoteRow> = []
  for (const [id, record] of serverNotes) {
    const pending = input.pending.has(pendingKey("note", id))
    const mirror = mirrorNotes.get(id)
    const next = pending && mirror !== undefined
      ? toNoteRow({ ...record, data: { ...record.data, ...mirror.data } })
      : toNoteRow(record)
    if (next.isPinned && !next.isArchived) notes.push(next)
  }
  for (const [id, mirror] of mirrorNotes) {
    if (serverNotes.has(id) || !input.pending.has(pendingKey("note", id))) continue
    const next = toNoteRow(mirror)
    if (next.isPinned && !next.isArchived) notes.push(next)
  }
  notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))

  const overdue = tasks.filter((task) => {
    const bucket = taskBucketOf(
      { dueAt: task.dueAt, dueDate: task.dueDate, status: task.status },
      bounds
    )
    return bucket === "overdue"
  }).length

  return {
    today: base.today,
    tomorrow: base.tomorrow,
    timeZone: base.timeZone,
    tasks,
    notes,
    counts: countsFor(tasks, notes, overdue),
    empty: {
      tasks: tasks.length === 0,
      events: true,
      reminders: true,
      habits: true,
      notes: notes.length === 0
    },
    source: "server"
  }
}

const EMPTY_COUNTS: TodayCounts = {
  tasks: 0,
  overdue: 0,
  events: 0,
  reminders: 0,
  habits: 0,
  notes: 0
}

const countsFor = (
  tasks: ReadonlyArray<TaskRow>,
  notes: ReadonlyArray<NoteRow>,
  overdue: number
): TodayCounts => ({
  ...EMPTY_COUNTS,
  tasks: tasks.length,
  overdue,
  notes: notes.length
})

/**
 * Aggregate the mirror into today's picture. The same `taskBucketOf` the
 * server's `TaskService.buckets` uses decides what belongs here, so a midnight
 * or DST edge cannot make the offline view disagree with the online one.
 */
export const fromMirrorToday = (input: {
  readonly tasks: ReadonlyArray<MirrorRecord>
  readonly notes: ReadonlyArray<MirrorRecord>
  readonly timeZone: string
  readonly now: string
}): TodayView => {
  const bounds = taskBucketBounds(input.timeZone, input.now)
  const rows = input.tasks.map(toTaskRow)
  const tasks = rows
    .filter((task) => task.status !== "done")
    .filter((task) => {
      const bucket = taskBucketOf(
        { dueAt: task.dueAt, dueDate: task.dueDate, status: task.status },
        bounds
      )
      return bucket === "overdue" || bucket === "today"
    })
    .sort((a, b) => compareTasks(a, b, { by: "dueDate", direction: "asc" }))

  const notes = input.notes
    .map(toNoteRow)
    .filter((note) => note.isPinned && !note.isArchived)

  const overdue = tasks.filter((task) => {
    const bucket = taskBucketOf(
      { dueAt: task.dueAt, dueDate: task.dueDate, status: task.status },
      bounds
    )
    return bucket === "overdue"
  }).length

  const counts = countsFor(tasks, notes, overdue)

  return {
    today: bounds.today,
    tomorrow: bounds.tomorrow,
    timeZone: input.timeZone,
    tasks,
    notes,
    counts,
    empty: {
      tasks: tasks.length === 0,
      events: true,
      reminders: true,
      habits: true,
      notes: notes.length === 0
    },
    source: "mirror"
  }
}
