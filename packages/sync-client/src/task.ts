import { Schema } from "effect"

import { defaultVisibilityFor } from "@tali/domain"

import type { LocalStore, MirrorRecord } from "./local-store/types"

/**
 * The Task projection the temporary P2.4 sync surface renders.
 *
 * The sync slice deliberately keeps Tasks as a placeholder feature screen, so
 * this is not the real Task aggregate: it only carries the fields the offline
 * quick-add and the convergence smoke check need. P2.6 replaces it with the
 * domain Task view.
 */
export const TaskRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  dueDate: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  hasSyncError: Schema.Boolean
})
export type TaskRow = typeof TaskRow.Type

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const taskRowOf = (record: MirrorRecord): TaskRow | undefined => {
  const title = text(record.data.title)
  if (title === undefined) return undefined

  return TaskRow.make({
    id: record.entityId,
    title,
    status: text(record.data.status) ?? "todo",
    dueDate: text(record.data.dueDate) ?? null,
    updatedAt: record.updatedAt,
    hasSyncError: record.syncError !== undefined
  })
}

/** Live task rows, newest edit last, skipping rows whose title never hydrated. */
export const taskRowsFromMirror = (
  records: ReadonlyArray<MirrorRecord>
): ReadonlyArray<TaskRow> =>
  records
    .flatMap(record => {
      const row = taskRowOf(record)
      return row === undefined ? [] : [row]
    })
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))

/** Read the live task snapshot straight from a local mirror. */
export const readTaskRows = async (
  store: LocalStore
): Promise<ReadonlyArray<TaskRow>> => taskRowsFromMirror(await store.list("task"))

export interface TaskCreateDraft {
  readonly title: string
  readonly dueDate: string | null
  readonly priority: "high" | "medium" | "low"
  readonly projectId: string | null
  readonly tagIds: ReadonlyArray<string>
  readonly timeZone: string
}

/**
 * The create patch the task registry hydrates. The id, client edit instant and
 * creation time are supplied by the caller (a Foldkit Command mints them in
 * `execute`, never while preparing its args).
 */
export const taskCreatePatch = (
  draft: TaskCreateDraft,
  id: string,
  now: string
): Readonly<Record<string, unknown>> => {
  const title = draft.title.trim()
  if (title === "") throw new Error("a task needs a title")

  return {
    id,
    type: "task",
    title,
    description: null,
    status: "todo",
    priority: draft.priority,
    dueAt: null,
    dueDate: draft.dueDate,
    timeZone: draft.timeZone,
    projectId: draft.projectId,
    tagIds: [...draft.tagIds],
    color: null,
    visibility: defaultVisibilityFor("task"),
    createdAt: now
  }
}

/**
 * The quick-add path: mint the id offline, commit the mirror row and outbox
 * entry together, and let the sync engine create the server row.
 */
export const createTaskInMirror = async (
  store: LocalStore,
  draft: TaskCreateDraft,
  id: string,
  now: string
): Promise<string> => {
  await store.writeLocal({
    entityType: "task",
    entityId: id,
    op: "upsert",
    // The owner is known offline so the editor can offer Share/Unshare before
    // the first ack; the server still stamps the authoritative owner.
    patch: { ...taskCreatePatch(draft, id, now), ownerId: store.userId },
    now
  })
  return id
}

/** The account's local calendar date, used for the offline quick-add. */
export const todayInZone = (now: Date, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}
