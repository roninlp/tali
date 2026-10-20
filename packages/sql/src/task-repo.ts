import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { type TagId, Task, type TaskId, type UserId } from "@tali/domain"

/**
 * D1-backed repository for `Task` (ticket #33; FR-TASK-01/02).
 *
 * Pure persistence: ids, version bumps, lifecycle timestamps and conflict
 * rules belong to `TaskService` (#36) and the sync registry (#34). D1 has no
 * interactive transactions, so multi-row commits (task + item_tags + feed)
 * are assembled by the caller as one `D1Client.batch()`.
 *
 * `tag_ids` is a denormalized JSON array on the row; `item_tags` remains the
 * source of truth. The mapper parses it so the domain model stays an array.
 */

const TASK_COLUMNS =
  `id, type, title, description, owner_id AS ownerId, household_id AS householdId, ` +
  `visibility, status, priority, due_at AS dueAt, due_date AS dueDate, ` +
  `time_zone AS timeZone, project_id AS projectId, tag_ids AS tagIds, color, ` +
  `started_at AS startedAt, completed_at AS completedAt, created_at AS createdAt, ` +
  `updated_at AS updatedAt, version, deleted_at AS deletedAt`

interface TaskRow extends Omit<Task, "tagIds"> {
  readonly tagIds: string
}

const toTask = (row: TaskRow): Task =>
  new Task({ ...row, tagIds: JSON.parse(row.tagIds) as ReadonlyArray<TagId> })

const encodeTagIds = (ids: ReadonlyArray<TagId>): string => JSON.stringify(ids)

export class TaskRepo extends Context.Service<TaskRepo>()("TaskRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const findById = (id: TaskId) =>
      Effect.map(
        sql<TaskRow>`SELECT ${sql.literal(TASK_COLUMNS)} FROM tasks WHERE id = ${id}`,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toTask)
      )

    /**
     * Live rows visible to one member: shared items plus their own private
     * ones. Mirrors the sync pull filter (`docs/sync-protocol-draft.md` §3.2).
     */
    const listVisible = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<TaskRow>`
          SELECT ${sql.literal(TASK_COLUMNS)} FROM tasks
          WHERE household_id = ${input.householdId}
            AND deleted_at IS NULL
            AND (owner_id = ${input.userId} OR visibility = 'shared')
          ORDER BY due_date IS NULL, due_date ASC, due_at ASC, updated_at DESC
        `,
        (rows) => rows.map(toTask)
      )

    /** "Today"/overdue buckets read by local due day, never by the server clock. */
    const listDueOn = (input: {
      readonly householdId: string
      readonly userId: UserId
      readonly dueDate: string
    }) =>
      Effect.map(
        sql<TaskRow>`
          SELECT ${sql.literal(TASK_COLUMNS)} FROM tasks
          WHERE household_id = ${input.householdId}
            AND deleted_at IS NULL
            AND due_date = ${input.dueDate}
            AND (owner_id = ${input.userId} OR visibility = 'shared')
          ORDER BY status ASC, priority ASC, id ASC
        `,
        (rows) => rows.map(toTask)
      )

    const insert = (task: Task) =>
      Effect.map(
        sql<TaskRow>`
          INSERT INTO tasks
            (id, type, title, description, owner_id, household_id, visibility,
             status, priority, due_at, due_date, time_zone, project_id, tag_ids,
             color, started_at, completed_at, created_at, updated_at, version, deleted_at)
          VALUES
            (${task.id}, ${task.type}, ${task.title}, ${task.description},
             ${task.ownerId}, ${task.householdId}, ${task.visibility},
             ${task.status}, ${task.priority}, ${task.dueAt}, ${task.dueDate},
             ${task.timeZone}, ${task.projectId}, ${encodeTagIds(task.tagIds)},
             ${task.color}, ${task.startedAt}, ${task.completedAt},
             ${task.createdAt}, ${task.updatedAt}, ${task.version}, ${task.deletedAt})
          RETURNING ${sql.literal(TASK_COLUMNS)}
        `,
        (rows) => toTask(rows[0]!)
      )

    /**
     * Full-row update. The caller owns the version CAS (`WHERE id AND
     * version = base`) in the sync path; this primitive is for service writes
     * that already hold the row.
     */
    const update = (task: Task) =>
      Effect.map(
        sql<TaskRow>`
          UPDATE tasks SET
            title = ${task.title},
            description = ${task.description},
            visibility = ${task.visibility},
            status = ${task.status},
            priority = ${task.priority},
            due_at = ${task.dueAt},
            due_date = ${task.dueDate},
            time_zone = ${task.timeZone},
            project_id = ${task.projectId},
            tag_ids = ${encodeTagIds(task.tagIds)},
            color = ${task.color},
            started_at = ${task.startedAt},
            completed_at = ${task.completedAt},
            updated_at = ${task.updatedAt},
            version = ${task.version},
            deleted_at = ${task.deletedAt}
          WHERE id = ${task.id}
          RETURNING ${sql.literal(TASK_COLUMNS)}
        `,
        (rows) => Option.map(Option.fromUndefinedOr(rows[0]), toTask)
      )

    /** Statement form so the sync engine can put the write in one batch. */
    const insertStatement = (task: Task) => sql`
      INSERT INTO tasks
        (id, type, title, description, owner_id, household_id, visibility,
         status, priority, due_at, due_date, time_zone, project_id, tag_ids,
         color, started_at, completed_at, created_at, updated_at, version, deleted_at)
      VALUES
        (${task.id}, ${task.type}, ${task.title}, ${task.description},
         ${task.ownerId}, ${task.householdId}, ${task.visibility},
         ${task.status}, ${task.priority}, ${task.dueAt}, ${task.dueDate},
         ${task.timeZone}, ${task.projectId}, ${encodeTagIds(task.tagIds)},
         ${task.color}, ${task.startedAt}, ${task.completedAt},
         ${task.createdAt}, ${task.updatedAt}, ${task.version}, ${task.deletedAt})
      ON CONFLICT DO NOTHING
    `

    return { findById, listVisible, listDueOn, insert, update, insertStatement } as const
  })
}) {}

export const TaskRepoLive = Layer.effect(TaskRepo, TaskRepo.make)
