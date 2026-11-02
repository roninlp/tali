import { Schema } from 'effect'

import type { LocalStore } from '@tali/sync-client'

/**
 * Task writes shared by Today and the Tasks board, ported from
 * `apps/web/src/lib/tasks/model.ts`.
 *
 * Every helper is the same #17 contract: one `writeLocal` commits the mirror
 * row and the outbox mutation in a single IndexedDB transaction, so the screen
 * is correct offline and the sync engine reconciles afterwards. The server
 * stays authoritative for versions and timestamps; these helpers only shape the
 * client's optimistic view.
 */

/**
 * Complete locally. The sync registry's done-wins merge stamps the
 * server-authoritative `completedAt`; writing it here too keeps the local
 * history list immediate (the field is not client-writable and is dropped by
 * the push's allowlist, then replaced by the ack).
 */
export const completeTaskInMirror = async (
  store: LocalStore,
  id: string,
  now: string,
): Promise<void> => {
  await store.writeLocal({
    entityType: 'task',
    entityId: id,
    op: 'upsert',
    patch: { status: 'done', completedAt: now },
    now,
  })
}

/** Move a task to a day (or to the no-date inbox with `null`). */
export const moveTaskInMirror = async (
  store: LocalStore,
  id: string,
  dueDate: string | null,
  timeZone: string,
  now: string,
): Promise<void> => {
  await store.writeLocal({
    entityType: 'task',
    entityId: id,
    op: 'upsert',
    patch: { dueAt: null, dueDate, timeZone },
    now,
  })
}

/**
 * Undo a completion: a task that had been started returns to `doing`,
 * everything else to `todo`.
 */
export const undoTaskInMirror = async (
  store: LocalStore,
  task: Readonly<{ id: string; startedAt: string | null }>,
  now: string,
): Promise<void> => {
  await store.writeLocal({
    entityType: 'task',
    entityId: task.id,
    op: 'upsert',
    patch: {
      status: task.startedAt !== null ? 'doing' : 'todo',
      completedAt: null,
    },
    now,
  })
}

/** The editable, client-writable fields; absent means "leave it". */
export const TaskEditPatch = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.Literals(['todo', 'doing', 'done'])),
  priority: Schema.optional(Schema.Literals(['high', 'medium', 'low'])),
  dueDate: Schema.optional(Schema.NullOr(Schema.String)),
  projectId: Schema.optional(Schema.NullOr(Schema.String)),
  tagIds: Schema.optional(Schema.Array(Schema.String)),
})
export type TaskEditPatch = typeof TaskEditPatch.Type

const localTaskPatch = (
  patch: TaskEditPatch,
  now: string,
): Readonly<Record<string, unknown>> => {
  const record: Record<string, unknown> = {}

  if (patch.title !== undefined) {
    record.title = patch.title.trim()
  }

  if (patch.description !== undefined) {
    record.description = patch.description
  }

  if (patch.status !== undefined) {
    record.status = patch.status

    // The server stamps the real value; mirroring it locally keeps undo
    // (doing → todo) correct when the ack has not arrived yet. It is not in
    // the sync writable allowlist, so the push drops it.
    if (patch.status === 'doing') {
      record.startedAt = now
    }
  }

  if (patch.priority !== undefined) {
    record.priority = patch.priority
  }

  if (patch.projectId !== undefined) {
    record.projectId = patch.projectId
  }

  if (patch.tagIds !== undefined) {
    record.tagIds = [...patch.tagIds]
  }

  if (patch.dueDate !== undefined) {
    // The UI is all-day only: setting a date clears any timed instant, and
    // clearing the date moves the task to the inbox.
    record.dueAt = null
    record.dueDate = patch.dueDate
  }

  return record
}

/** Patch one task in the mirror + outbox. The debounced autosave target. */
export const updateTaskInMirror = async (
  store: LocalStore,
  id: string,
  patch: TaskEditPatch,
  now: string,
): Promise<void> => {
  const record = localTaskPatch(patch, now)

  if (Reflect.ownKeys(record).length === 0) {
    return
  }

  await store.writeLocal({
    entityType: 'task',
    entityId: id,
    op: 'upsert',
    patch: record,
    now,
  })
}

export interface MirrorCreate {
  readonly id: string
  readonly now: string
}

/** Create a project offline; the sidebar renders it immediately. */
export const createProjectInMirror = async (
  store: LocalStore,
  project: MirrorCreate & Readonly<{ title: string }>,
): Promise<string> => {
  const title = project.title.trim()

  if (title === '') {
    throw new Error('a project needs a title')
  }

  await store.writeLocal({
    entityType: 'project',
    entityId: project.id,
    op: 'upsert',
    patch: {
      id: project.id,
      type: 'project',
      title,
      color: null,
      createdAt: project.now,
    },
    now: project.now,
  })

  return project.id
}

/** Create a tag offline (multi-tag chips use it immediately). */
export const createTagInMirror = async (
  store: LocalStore,
  tag: MirrorCreate & Readonly<{ name: string }>,
): Promise<string> => {
  const name = tag.name.trim()

  if (name === '') {
    throw new Error('a tag needs a name')
  }

  await store.writeLocal({
    entityType: 'tag',
    entityId: tag.id,
    op: 'upsert',
    patch: {
      id: tag.id,
      type: 'tag',
      name,
      color: null,
      createdAt: tag.now,
    },
    now: tag.now,
  })

  return tag.id
}
