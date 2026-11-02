import { Array, Option, Schema } from 'effect'

import { DEFAULT_TIME_ZONE, defaultVisibilityFor } from '@tali/domain'
import type { LocalStore, MirrorRecord } from '@tali/sync-client'

import {
  HabitEntryRow,
  HabitRow,
  sortHabitRows,
  toHabitEntryRow,
  toHabitRow,
} from './habits-model'
import { CalendarRecurrenceRule } from './lib/calendar-data'
import { EventRow, eventRowsFromMirror } from './lib/event-writes'
import {
  noteDisplayTitle,
  noteExcerpt,
  noteTextFromData,
  tagIdsOf,
} from './lib/note-body'
import { OccasionRow, occasionRowsFromMirror } from './lib/occasion-writes'
import type { ServerNote, ServerTask } from './lib/today-api'
import {
  ListItemRow,
  ListRow,
  listItemRowsFromMirror,
  listRowsFromMirror,
  sortListRows,
} from './lists-model'

/**
 * The client read model the feature screens render from.
 *
 * The mirror is the source: every write commits the IndexedDB row and its
 * outbox entry in one transaction, so a screen can paint a change offline
 * before the sync engine drains. These projections are the plain, JSON-safe
 * shapes the Foldkit Model holds; they deliberately carry no branded domain
 * values, matching `preferences-model.ts` and `session.ts`.
 */

export const TaskRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  status: Schema.Literals(['todo', 'doing', 'done']),
  priority: Schema.Literals(['high', 'medium', 'low']),
  dueDate: Schema.NullOr(Schema.String),
  dueAt: Schema.NullOr(Schema.String),
  timeZone: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  tagIds: Schema.Array(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  recurrence: Schema.optional(Schema.NullOr(CalendarRecurrenceRule)),
  recurrenceMode: Schema.optional(
    Schema.NullOr(Schema.Literals(['onCompletion', 'onDueDate'])),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  version: Schema.Int,
  hasSyncError: Schema.Boolean,
  /** Populated from the mirror row; optional for server/legacy projections. */
  ownerId: Schema.optional(Schema.NullOr(Schema.String)),
  visibility: Schema.optional(Schema.Literals(['private', 'shared'])),
})
export type TaskRow = typeof TaskRow.Type

export const ProjectRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  color: Schema.NullOr(Schema.String),
})
export type ProjectRow = typeof ProjectRow.Type

export const TagRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
})
export type TagRow = typeof TagRow.Type

export const NoteRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  text: Schema.String,
  excerpt: Schema.String,
  isPinned: Schema.Boolean,
  isArchived: Schema.Boolean,
  tagIds: Schema.Array(Schema.String),
  updatedAt: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
  version: Schema.Int,
  syncErrorCode: Schema.Option(Schema.String),
})
export type NoteRow = typeof NoteRow.Type

export const MirrorSnapshot = Schema.Struct({
  tasks: Schema.Array(TaskRow),
  projects: Schema.Array(ProjectRow),
  tags: Schema.Array(TagRow),
  notes: Schema.Array(NoteRow),
  trashedNotes: Schema.Array(NoteRow),
  habits: Schema.Array(HabitRow),
  habitEntries: Schema.Array(HabitEntryRow),
  lists: Schema.Array(ListRow),
  listItems: Schema.Array(ListItemRow),
  events: Schema.Array(EventRow),
  trashedEvents: Schema.Array(EventRow),
  occasions: Schema.Array(OccasionRow),
  trashedOccasions: Schema.Array(OccasionRow),
})
export type MirrorSnapshot = typeof MirrorSnapshot.Type

export const emptyMirrorSnapshot = (): MirrorSnapshot =>
  MirrorSnapshot.make({
    tasks: [],
    projects: [],
    tags: [],
    notes: [],
    trashedNotes: [],
    habits: [],
    habitEntries: [],
    lists: [],
    listItems: [],
    events: [],
    trashedEvents: [],
    occasions: [],
    trashedOccasions: [],
  })

const asNullableString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

const asPriority = (value: unknown): TaskRow['priority'] =>
  value === 'high' || value === 'low' ? value : 'medium'

const asStatus = (value: unknown): TaskRow['status'] =>
  value === 'doing' || value === 'done' ? value : 'todo'

const asRecurrence = (value: unknown): TaskRow['recurrence'] => {
  const parsed =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value)
          } catch {
            return undefined
          }
        })()
      : value
  const decoded = Schema.decodeUnknownOption(CalendarRecurrenceRule)(parsed)

  return Option.getOrUndefined(decoded)
}

const asRecurrenceMode = (value: unknown): TaskRow['recurrenceMode'] =>
  value === 'onCompletion' || value === 'onDueDate' ? value : null

/** Project a mirrored task row into the shape the screens understand. */
export const toTaskRow = (record: MirrorRecord): TaskRow =>
  TaskRow.make({
    id: record.entityId,
    title: typeof record.data.title === 'string' ? record.data.title : '',
    description: asNullableString(record.data.description),
    status: asStatus(record.data.status),
    priority: asPriority(record.data.priority),
    dueDate: asNullableString(record.data.dueDate),
    dueAt: asNullableString(record.data.dueAt),
    timeZone: asString(record.data.timeZone) ?? DEFAULT_TIME_ZONE,
    projectId: asNullableString(record.data.projectId),
    tagIds: Array.filter(
      Array.isArray(record.data.tagIds) ? record.data.tagIds : [],
      (entry): entry is string => typeof entry === 'string',
    ),
    startedAt: asNullableString(record.data.startedAt),
    completedAt: asNullableString(record.data.completedAt),
    recurrence: asRecurrence(record.data.recurrence),
    recurrenceMode: asRecurrenceMode(record.data.recurrenceMode),
    createdAt: asNullableString(record.data.createdAt) ?? record.updatedAt,
    updatedAt: record.updatedAt,
    version: record.version,
    hasSyncError: record.syncError !== undefined,
    ownerId: asNullableString(record.data.ownerId),
    visibility:
      record.data.visibility === 'private' || record.data.visibility === 'shared'
        ? record.data.visibility
        : defaultVisibilityFor('task'),
  })

/** Project a mirrored note row into the pinned-note lane's shape. */
export const toNoteRow = (record: MirrorRecord): NoteRow =>
  NoteRow.make({
    id: record.entityId,
    title: noteDisplayTitle(record.data),
    text: noteTextFromData(record.data),
    excerpt: noteExcerpt(record.data),
    isPinned: record.data.isPinned === true,
    isArchived: record.data.isArchived === true,
    tagIds: tagIdsOf(record.data.tagIds),
    updatedAt: record.updatedAt,
    deletedAt: record.deletedAt,
    version: record.version,
    syncErrorCode: Option.fromNullishOr(record.syncError?.code),
  })

/** Project a mirrored project row into the filter sidebar's shape. */
export const toProjectRow = (record: MirrorRecord): ProjectRow =>
  ProjectRow.make({
    id: record.entityId,
    title: typeof record.data.title === 'string' ? record.data.title : '',
    color: asNullableString(record.data.color),
  })

/** Project a mirrored tag row into the chip / filter shape. */
export const toTagRow = (record: MirrorRecord): TagRow =>
  TagRow.make({
    id: record.entityId,
    name: typeof record.data.name === 'string' ? record.data.name : '',
    color: asNullableString(record.data.color),
  })

export const taskRowsFromMirror = (
  records: ReadonlyArray<MirrorRecord>,
): ReadonlyArray<TaskRow> => Array.map(records, toTaskRow)

/** Stable project order for the filter sidebar and quick-add. */
export const sortProjects = (
  projects: ReadonlyArray<ProjectRow>,
): ReadonlyArray<ProjectRow> =>
  [...projects].sort((left, right) =>
    left.title.localeCompare(right.title, 'fa'),
  )

/** Stable tag order for chips and the filter bar. */
export const sortTags = (tags: ReadonlyArray<TagRow>): ReadonlyArray<TagRow> =>
  [...tags].sort((left, right) => left.name.localeCompare(right.name, 'fa'))

export const projectRowsFromMirror = (
  records: ReadonlyArray<MirrorRecord>,
): ReadonlyArray<ProjectRow> => sortProjects(Array.map(records, toProjectRow))

export const tagRowsFromMirror = (
  records: ReadonlyArray<MirrorRecord>,
): ReadonlyArray<TagRow> => sortTags(Array.map(records, toTagRow))

export const noteRowsFromMirror = (
  records: ReadonlyArray<MirrorRecord>,
): ReadonlyArray<NoteRow> => Array.map(records, toNoteRow)

export const trashedNoteRowsFromMirror = (
  records: ReadonlyArray<MirrorRecord>,
): ReadonlyArray<NoteRow> => Array.map(records, toNoteRow)

export const habitRowsFromMirror = (
  records: ReadonlyArray<MirrorRecord>,
): ReadonlyArray<HabitRow> => sortHabitRows(Array.map(records, toHabitRow))

export const habitEntryRowsFromMirror = (
  records: ReadonlyArray<MirrorRecord>,
): ReadonlyArray<HabitEntryRow> => Array.map(records, toHabitEntryRow)

/** The same snapshot shape a server refresh produces, read from the mirror. */
export const readMirrorSnapshot = async (
  store: LocalStore,
): Promise<MirrorSnapshot> => {
  const [
    tasks,
    projects,
    tags,
    notes,
    trashedNotes,
    habits,
    habitEntries,
    lists,
    listItems,
    events,
    trashedEvents,
    occasions,
    trashedOccasions,
  ] = await Promise.all([
    store.list('task'),
    store.list('project'),
    store.list('tag'),
    store.list('note'),
    store.listTrashed('note'),
    store.list('habit'),
    store.list('habitEntry'),
    store.list('list'),
    store.list('listItem'),
    store.list('event'),
    store.listTrashed('event'),
    store.list('occasion'),
    store.listTrashed('occasion'),
  ])

  return MirrorSnapshot.make({
    tasks: taskRowsFromMirror(tasks),
    projects: projectRowsFromMirror(projects),
    tags: tagRowsFromMirror(tags),
    notes: noteRowsFromMirror(notes),
    trashedNotes: trashedNoteRowsFromMirror(trashedNotes),
    habits: habitRowsFromMirror(habits),
    habitEntries: habitEntryRowsFromMirror(habitEntries),
    lists: sortListRows(listRowsFromMirror(lists)),
    listItems: listItemRowsFromMirror(listItems),
    events: eventRowsFromMirror(events),
    trashedEvents: eventRowsFromMirror(trashedEvents),
    occasions: occasionRowsFromMirror(occasions),
    trashedOccasions: occasionRowsFromMirror(trashedOccasions),
  })
}

/** The overlay key for one entity: the same `type\0id` pair Today uses. */
export const entityKey = (entityType: string, entityId: string): string =>
  `${entityType}\u0000${entityId}`

export const taskKey = (taskId: string): string => entityKey('task', taskId)

export const noteKey = (noteId: string): string => entityKey('note', noteId)

/** Keys with an unsent outbox entry, for the per-row overlay. */
export const pendingKeysOf = (
  entries: ReadonlyArray<{
    readonly entityType: string
    readonly entityId: string
  }>,
): ReadonlyArray<string> =>
  Array.map(entries, entry => entityKey(entry.entityType, entry.entityId))

/** A note is visible on Today while it is pinned and not archived. */
export const isPinnedNote = (note: NoteRow): boolean =>
  note.isPinned && !note.isArchived && note.deletedAt === null

export const liveNotes = (
  notes: ReadonlyArray<NoteRow>,
): ReadonlyArray<NoteRow> => Array.filter(notes, isPinnedNote)

export const isLiveTask = (task: TaskRow): boolean => task.status !== 'done'

/** Server-returned rows reuse the local projectors' defaults. */
export const taskRowFromServer = (task: ServerTask): TaskRow =>
  TaskRow.make({
    id: task.id,
    title: task.title,
    description: task.description ?? null,
    status: asStatus(task.status),
    priority: asPriority(task.priority),
    dueDate: task.dueDate ?? null,
    dueAt: task.dueAt ?? null,
    timeZone: asString(task.timeZone) ?? DEFAULT_TIME_ZONE,
    projectId: task.projectId ?? null,
    tagIds: task.tagIds ?? [],
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? null,
    createdAt: task.createdAt ?? task.updatedAt ?? '',
    updatedAt: task.updatedAt ?? '',
    version: task.version ?? 0,
    hasSyncError: false,
    ownerId: task.ownerId ?? null,
    visibility: task.visibility ?? defaultVisibilityFor('task'),
  })

export const noteRowFromServer = (note: ServerNote): NoteRow => {
  const data: Readonly<Record<string, unknown>> = {
    title: note.title ?? '',
    body: note.body,
    plainText: note.plainText ?? '',
  }

  return NoteRow.make({
    id: note.id,
    title: noteDisplayTitle(data),
    text: noteTextFromData(data),
    excerpt: noteExcerpt(data),
    isPinned: note.isPinned === true,
    isArchived: note.isArchived === true,
    tagIds: note.tagIds ?? [],
    updatedAt: note.updatedAt ?? '',
    deletedAt: note.deletedAt ?? null,
    version: note.version ?? 0,
    syncErrorCode: Option.none(),
  })
}

/** Stable order for a pinned-note lane: newest edit first, id as tie-break. */
const compareText = (left: string, right: string): -1 | 0 | 1 =>
  left < right ? -1 : left > right ? 1 : 0

export const sortNotes = (
  notes: ReadonlyArray<NoteRow>,
): ReadonlyArray<NoteRow> =>
  [...notes].sort((left, right) => {
    const byUpdated = compareText(right.updatedAt, left.updatedAt)
    return byUpdated !== 0 ? byUpdated : compareText(left.id, right.id)
  })

/** The task order the board and Today share: due date, priority, then id. */
const priorityRank: Readonly<Record<TaskRow['priority'], number>> = {
  high: 0,
  medium: 1,
  low: 2,
}

const dueSortKey = (task: TaskRow): string =>
  task.dueDate ?? task.dueAt ?? '9999-99-99'

export const compareTasksByDueDate = (
  left: TaskRow,
  right: TaskRow,
): -1 | 0 | 1 => {
  const byDue = compareText(dueSortKey(left), dueSortKey(right))
  if (byDue !== 0) {
    return byDue
  }

  const byPriority = priorityRank[left.priority] - priorityRank[right.priority]
  if (byPriority !== 0) {
    return byPriority < 0 ? -1 : 1
  }

  return compareText(left.id, right.id)
}

export const sortTasks = (
  tasks: ReadonlyArray<TaskRow>,
): ReadonlyArray<TaskRow> => [...tasks].sort(compareTasksByDueDate)
