import { Array, Option, Schema } from 'effect'

import {
  DEFAULT_TIME_ZONE,
  defaultVisibilityFor,
  entityKey,
  resolveTimeZone,
  SYNC_ENTITY_TYPES,
  type SyncEntityType,
} from '@tali/domain'
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
import { JsonField } from './lib/json-field'
import {
  asNonEmptyStringOption,
  mirrorCreatedAt,
  mirrorId,
  mirrorMeta,
  mirrorNullableString,
  mirrorText,
} from './lib/mirror-field'
import {
  NoteData,
  emptyNoteData,
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

const asPriority = Schema.decodeUnknownOption(
  Schema.Literals(['high', 'medium', 'low']),
)

const asStatus = Schema.decodeUnknownOption(
  Schema.Literals(['todo', 'doing', 'done']),
)

const asRecurrence = Schema.decodeUnknownOption(
  JsonField(CalendarRecurrenceRule),
)

const asRecurrenceMode = Schema.decodeUnknownOption(
  Schema.Literals(['onCompletion', 'onDueDate']),
)

const asTagIds = Schema.decodeUnknownOption(
  JsonField(Schema.Array(Schema.String)),
)

const asNoteData = Schema.decodeUnknownOption(NoteData)

/** The status, priority, zone and visibility a TaskRow decodes from. */
interface TaskRowSourceFields {
  readonly status: unknown
  readonly priority: unknown
  readonly timeZone: unknown
  readonly visibility: unknown
}

/** The same four fields after the TaskRow fallback policy has applied. */
interface DefaultedTaskFields {
  readonly status: TaskRow['status']
  readonly priority: TaskRow['priority']
  readonly timeZone: string
  readonly visibility: NonNullable<TaskRow['visibility']>
}

/**
 * The TaskRow fallback policy, held once: whatever source a row decodes from
 * — the mirror's untyped JSON or a server response — an unknown status reads
 * as `todo`, an unknown priority as `medium`, an absent or unusable zone as
 * the household default, and an unset visibility as the aggregate's policy
 * default.
 */
const defaultedTaskFields = (
  fields: TaskRowSourceFields,
): DefaultedTaskFields => ({
  status: Option.getOrElse(asStatus(fields.status), () => 'todo'),
  priority: Option.getOrElse(asPriority(fields.priority), () => 'medium'),
  timeZone: resolveTimeZone(
    Option.getOrElse(
      asNonEmptyStringOption(fields.timeZone),
      () => DEFAULT_TIME_ZONE,
    ),
  ),
  visibility:
    fields.visibility === 'private' || fields.visibility === 'shared'
      ? fields.visibility
      : defaultVisibilityFor('task'),
})

/** Project a mirrored task row into the shape the screens understand. */
export const toTaskRow = (record: MirrorRecord): TaskRow =>
  TaskRow.make({
    id: mirrorId(record),
    title: mirrorText(record, 'title'),
    description: mirrorNullableString(record, 'description'),
    ...defaultedTaskFields({
      status: record.data.status,
      priority: record.data.priority,
      timeZone: record.data.timeZone,
      visibility: record.data.visibility,
    }),
    dueDate: mirrorNullableString(record, 'dueDate'),
    dueAt: mirrorNullableString(record, 'dueAt'),
    projectId: mirrorNullableString(record, 'projectId'),
    tagIds: Option.getOrElse(asTagIds(record.data.tagIds), () => []),
    startedAt: mirrorNullableString(record, 'startedAt'),
    completedAt: mirrorNullableString(record, 'completedAt'),
    recurrence: Option.getOrUndefined(asRecurrence(record.data.recurrence)),
    recurrenceMode: Option.getOrNull(
      asRecurrenceMode(record.data.recurrenceMode),
    ),
    createdAt: mirrorCreatedAt(record),
    ...mirrorMeta(record),
    ownerId: mirrorNullableString(record, 'ownerId'),
  })

/** Project a mirrored note row into the pinned-note lane's shape. */
export const toNoteRow = (record: MirrorRecord): NoteRow => {
  const data = Option.getOrElse(asNoteData(record.data), emptyNoteData)

  return NoteRow.make({
    id: mirrorId(record),
    title: noteDisplayTitle(data),
    text: noteTextFromData(data),
    excerpt: noteExcerpt(data),
    isPinned: record.data.isPinned === true,
    isArchived: record.data.isArchived === true,
    tagIds: tagIdsOf(data.tagIds),
    updatedAt: record.updatedAt,
    deletedAt: record.deletedAt,
    version: record.version,
    syncErrorCode: Option.fromNullishOr(record.syncError?.code),
  })
}

/** Project a mirrored project row into the filter sidebar's shape. */
export const toProjectRow = (record: MirrorRecord): ProjectRow =>
  ProjectRow.make({
    id: mirrorId(record),
    title: mirrorText(record, 'title'),
    color: mirrorNullableString(record, 'color'),
  })

/** Project a mirrored tag row into the chip / filter shape. */
export const toTagRow = (record: MirrorRecord): TagRow =>
  TagRow.make({
    id: mirrorId(record),
    name: mirrorText(record, 'name'),
    color: mirrorNullableString(record, 'color'),
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

/** Which store reads one entity type contributes to the snapshot. */
interface SnapshotReads {
  readonly live: boolean
  readonly trashed: boolean
}

/**
 * The per-type read policy (#117), exhaustive over the domain's
 * `SyncEntityType` union so a new aggregate fails to compile until its policy
 * is chosen here, like `VISIBILITY_POLICY` in `@tali/domain`. Most types read
 * only live rows; notes, events and occasions also feed a trash lane.
 * Reminders are the one type with no snapshot field yet — the ledger inbox
 * reads them through the RPC client — so neither read runs for them.
 */
type SnapshotReadPolicy = Readonly<Record<SyncEntityType, SnapshotReads>>

const SNAPSHOT_READS: SnapshotReadPolicy = {
  habit: { live: true, trashed: false },
  habitEntry: { live: true, trashed: false },
  event: { live: true, trashed: true },
  occasion: { live: true, trashed: true },
  task: { live: true, trashed: false },
  reminder: { live: false, trashed: false },
  note: { live: true, trashed: true },
  tag: { live: true, trashed: false },
  list: { live: true, trashed: false },
  listItem: { live: true, trashed: false },
  project: { live: true, trashed: false },
}

/** One entity type's mirror rows, live and trashed (`[]` when not read). */
interface MirrorRows {
  readonly live: ReadonlyArray<MirrorRecord>
  readonly trashed: ReadonlyArray<MirrorRecord>
}

/** Each type's rows, keyed by the domain's entity-type list. */
type MirrorRowsByType = { readonly [T in SyncEntityType]: MirrorRows }

/**
 * Read every entity type's rows in one parallel pass, driven by the domain's
 * `SYNC_ENTITY_TYPES` list and the per-type policy above.
 */
const readMirrorRows = async (store: LocalStore): Promise<MirrorRowsByType> => {
  const entries = await Promise.all(
    SYNC_ENTITY_TYPES.map(async entityType => {
      const { live, trashed } = SNAPSHOT_READS[entityType]

      const [liveRows, trashedRows] = await Promise.all([
        live ? store.list(entityType) : [],
        trashed ? store.listTrashed(entityType) : [],
      ])

      return [entityType, { live: liveRows, trashed: trashedRows }] as const
    }),
  )

  // SAFETY: `SNAPSHOT_READS` is exhaustive over `SYNC_ENTITY_TYPES`, which is
  // the same list the loop iterates, so every `SyncEntityType` key is present;
  // `Object.fromEntries` just cannot express the key set in its return type.
  return Object.fromEntries(entries) as MirrorRowsByType
}

/** The same snapshot shape a server refresh produces, read from the mirror. */
export const readMirrorSnapshot = async (
  store: LocalStore,
): Promise<MirrorSnapshot> => {
  const rows = await readMirrorRows(store)

  return MirrorSnapshot.make({
    tasks: taskRowsFromMirror(rows.task.live),
    projects: projectRowsFromMirror(rows.project.live),
    tags: tagRowsFromMirror(rows.tag.live),
    notes: noteRowsFromMirror(rows.note.live),
    trashedNotes: trashedNoteRowsFromMirror(rows.note.trashed),
    habits: habitRowsFromMirror(rows.habit.live),
    habitEntries: habitEntryRowsFromMirror(rows.habitEntry.live),
    lists: sortListRows(listRowsFromMirror(rows.list.live)),
    listItems: listItemRowsFromMirror(rows.listItem.live),
    events: eventRowsFromMirror(rows.event.live),
    trashedEvents: eventRowsFromMirror(rows.event.trashed),
    occasions: occasionRowsFromMirror(rows.occasion.live),
    trashedOccasions: occasionRowsFromMirror(rows.occasion.trashed),
  })
}

/**
 * The overlay key for one entity: the domain's `type\0id` identity, re-exported
 * so screens keep importing it from the mirror they already read.
 */
export { entityKey } from '@tali/domain'

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

/**
 * Ids of one entity type among the sync Model's pending `type\0id` keys, the
 * one step past the key builders: a screen holding the keys asks for the ids
 * it can actually compare with its rows.
 */
export const pendingIdsOf = (
  entityType: string,
  keys: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const prefix = entityKey(entityType, '')

  return Array.flatMap(keys, key =>
    key.startsWith(prefix) ? [key.slice(prefix.length)] : [],
  )
}

/** The set form of `pendingIdsOf`, for per-row membership checks. */
export const pendingIdSetOf = (
  entityType: string,
  keys: ReadonlyArray<string>,
): ReadonlySet<string> => new Set(pendingIdsOf(entityType, keys))

/** A note is visible on Today while it is pinned and not archived. */
export const isPinnedNote = (note: NoteRow): boolean =>
  note.isPinned && !note.isArchived && note.deletedAt === null

export const liveNotes = (
  notes: ReadonlyArray<NoteRow>,
): ReadonlyArray<NoteRow> => Array.filter(notes, isPinnedNote)

export const isLiveTask = (task: TaskRow): boolean => task.status !== 'done'

/** Server-returned rows decode through the same defaults as the mirror's. */
export const taskRowFromServer = (task: ServerTask): TaskRow =>
  TaskRow.make({
    id: task.id,
    title: task.title,
    description: task.description ?? null,
    ...defaultedTaskFields({
      status: task.status,
      priority: task.priority,
      timeZone: task.timeZone,
      visibility: task.visibility,
    }),
    dueDate: task.dueDate ?? null,
    dueAt: task.dueAt ?? null,
    projectId: task.projectId ?? null,
    tagIds: task.tagIds ?? [],
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? null,
    createdAt: task.createdAt ?? task.updatedAt ?? '',
    updatedAt: task.updatedAt ?? '',
    version: task.version ?? 0,
    hasSyncError: false,
    ownerId: task.ownerId ?? null,
  })

export const noteRowFromServer = (note: ServerNote): NoteRow => {
  const data = NoteData.make({
    title: note.title ?? '',
    body: note.body,
    plainText: note.plainText ?? '',
  })

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
