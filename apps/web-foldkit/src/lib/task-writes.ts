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
