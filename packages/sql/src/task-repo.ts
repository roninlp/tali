import { Context, Effect, Layer, Option } from "effect"
import { SqlClient, Statement } from "effect/sql"
import {
  type Priority,
  type ProjectId,
  type TagId,
  Task,
  type TaskId,
  type TaskStatus,
  type UserId
} from "@tali/domain"

/**
 * D1-backed repository for `Task` (ticket #33; FR-TASK-01/02/05).
 *
 * Pure persistence: ids, version bumps, lifecycle timestamps and conflict
 * rules belong to `TaskService` (#36) and the sync registry (#34). D1 has no
 * interactive transactions, so multi-row commits (task + item_tags + feed)
 * are assembled by the caller as one `D1Client.batch()`.
 *
 * The read side exposes three bucket primitives:
 *
 * - `listDueDateRange` for all-day rows (`due_date`, a local calendar date);
 * - `listDueInstantRange` for timed rows (`due_at`, a UTC instant);
 * - `listNoDue` for rows with neither.
 *
 * Bucket boundaries are computed once by `TaskService` in the viewer's zone
 * (`taskBucketBounds`), so a DST transition never changes a day's length here.
 *
 * `tag_ids` is a denormalized JSON array on the row; `item_tags` remains the
 * source of truth. The mapper parses it so the domain model stays an array.
 */

const TASK_COLUMNS =
  `id, type, title, description, owner_id AS ownerId, household_id AS householdId, ` +
  `visibility, status, priority, due_at AS dueAt, due_date AS dueDate, ` +
  `time_zone AS timeZone, project_id AS projectId, tag_ids AS tagIds, color, ` +
  `recurrence, recurrence_mode AS recurrenceMode, ` +
  `started_at AS startedAt, completed_at AS completedAt, created_at AS createdAt, ` +
  `updated_at AS updatedAt, version, deleted_at AS deletedAt`

interface TaskRow extends Omit<Task, "tagIds" | "recurrence"> {
  readonly tagIds: string
  /** JSON text in SQLite; parsed into the structured rule by `toTask`. */
  readonly recurrence: string | null
}

const toTask = (row: TaskRow): Task =>
  new Task({
    ...row,
    tagIds: JSON.parse(row.tagIds) as ReadonlyArray<TagId>,
    recurrence: row.recurrence === null
      ? null
      : (JSON.parse(row.recurrence) as Task["recurrence"])
  })

const encodeTagIds = (ids: ReadonlyArray<TagId>): string => JSON.stringify(ids)

/** Rules are JSON text, `NULL` for a one-off task. */
const encodeRecurrence = (rule: Task["recurrence"]): string | null =>
  rule === null ? null : JSON.stringify(rule)

export interface TaskQuery {
  readonly householdId: string
  readonly userId: UserId
  readonly projectId?: ProjectId | null
  readonly tagIds?: ReadonlyArray<TagId>
  readonly priority?: Priority
  readonly status?: TaskStatus
  readonly dueDateFrom?: string
  readonly dueDateBefore?: string
  readonly dueInstantFrom?: string
  readonly dueInstantBefore?: string
  readonly noDue?: boolean
  readonly excludeDone?: boolean
  readonly includeArchived?: boolean
  /** ISO cutoff; done rows completed before it are archived out of normal reads. */
  readonly completionCutoff?: string
  readonly sort?: {
    readonly by: "dueDate" | "priority" | "status" | "createdAt" | "updatedAt" | "title"
    readonly direction: "asc" | "desc"
  }
}

/**
 * Static, trusted ORDER BY fragments. A sort field/direction is validated by
 * the contract's literal schema; client values are never interpolated. The
 * trailing `id ASC` is the stable tiebreak for equal keys.
 */
const orderBy = (sort: NonNullable<TaskQuery["sort"]>): string => {
  const direction = sort.direction === "desc" ? "DESC" : "ASC"
  switch (sort.by) {
    case "priority":
      return `CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ${direction},
        CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END ASC,
        due_date IS NULL, due_date ASC, due_at ASC, id ASC`
    case "status":
      return `CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END ${direction},
        CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC,
        due_date IS NULL, due_date ASC, due_at ASC, id ASC`
    case "createdAt":
      return `created_at ${direction}, id ASC`
    case "updatedAt":
      return `updated_at ${direction}, id ASC`
    case "title":
      return `title COLLATE NOCASE ${direction}, id ASC`
    case "dueDate":
    default:
      return `due_date IS NULL, due_date ${direction}, due_at ${direction}, id ASC`
  }
}

const bucketOrder = `
  CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC,
  due_date IS NULL, due_date ASC, due_at ASC, id ASC
`

export class TaskRepo extends Context.Service<TaskRepo>()("TaskRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    /** The visibility filter every task read shares (private owner-only, else shared). */
    const visibleScope = (input: {
      readonly householdId: string
      readonly userId: UserId
    }): Statement.Fragment =>
      sql`
        household_id = ${input.householdId}
        AND deleted_at IS NULL
        AND (owner_id = ${input.userId} OR visibility = 'shared')
      `

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
          WHERE ${visibleScope(input)}
          ORDER BY due_date IS NULL, due_date ASC, due_at ASC, updated_at DESC
        `,
        (rows) => rows.map(toTask)
      )

    /**
     * Filter + sort for the task list (FR-TASK-02). All predicates are bound
     * parameters; the only interpolated SQL is the trusted ORDER BY above.
     */
    const listFiltered = (input: TaskQuery) =>
      Effect.gen(function*() {
        const conditions: Array<Statement.Fragment> = [visibleScope(input)]

        if (input.projectId !== undefined) {
          conditions.push(
            input.projectId === null
              ? sql`project_id IS NULL`
              : sql`project_id = ${input.projectId}`
          )
        }
        if (input.tagIds !== undefined && input.tagIds.length > 0) {
          // "any of these tags" without an `IN` list: D1's compiler treats a
          // qualified `alias.column` passed to `sql.in` as a table name.
          conditions.push(
            sql`(${sql.or(
              input.tagIds.map((tagId) =>
                sql`EXISTS (
                  SELECT 1 FROM json_each(tasks.tag_ids) AS jt
                  WHERE jt.value = ${tagId}
                )`
              )
            )})`
          )
        }
        if (input.priority !== undefined) {
          conditions.push(sql`priority = ${input.priority}`)
        }
        if (input.status !== undefined) {
          conditions.push(sql`status = ${input.status}`)
        }
        if (input.excludeDone === true) {
          conditions.push(sql`status != 'done'`)
        }
        if (input.noDue === true) {
          conditions.push(sql`due_at IS NULL AND due_date IS NULL`)
        }
        if (input.includeArchived !== true && input.completionCutoff !== undefined) {
          conditions.push(
            sql`(status != 'done' OR (completed_at IS NOT NULL AND completed_at >= ${input.completionCutoff}))`
          )
        }

        // A date range and an instant range are alternatives (a task has one
        // due shape), so they are OR'ed rather than AND'ed.
        const dueRanges: Array<Statement.Fragment> = []
        if (input.dueDateFrom !== undefined || input.dueDateBefore !== undefined) {
          const parts: Array<Statement.Fragment> = [
            sql`due_at IS NULL`,
            sql`due_date IS NOT NULL`
          ]
          if (input.dueDateFrom !== undefined) {
            parts.push(sql`due_date >= ${input.dueDateFrom}`)
          }
          if (input.dueDateBefore !== undefined) {
            parts.push(sql`due_date < ${input.dueDateBefore}`)
          }
          dueRanges.push(sql`(${sql.and(parts)})`)
        }
        if (input.dueInstantFrom !== undefined || input.dueInstantBefore !== undefined) {
          const parts: Array<Statement.Fragment> = [sql`due_at IS NOT NULL`]
          if (input.dueInstantFrom !== undefined) {
            parts.push(sql`due_at >= ${input.dueInstantFrom}`)
          }
          if (input.dueInstantBefore !== undefined) {
            parts.push(sql`due_at < ${input.dueInstantBefore}`)
          }
          dueRanges.push(sql`(${sql.and(parts)})`)
        }
        if (dueRanges.length > 0) {
          conditions.push(sql`(${sql.or(dueRanges)})`)
        }

        const rows = yield* sql<TaskRow>`
          SELECT ${sql.literal(TASK_COLUMNS)} FROM tasks
          WHERE ${sql.and(conditions)}
          ORDER BY ${sql.literal(orderBy(input.sort ?? { by: "dueDate", direction: "asc" }))}
        `
        return rows.map(toTask)
      })

    /** All-day rows in `[from, before)` on the local due date. */
    const listDueDateRange = (input: {
      readonly householdId: string
      readonly userId: UserId
      readonly from?: string
      readonly before?: string
    }) =>
      Effect.gen(function*() {
        const bounds: Array<Statement.Fragment> = [sql`due_at IS NULL`, sql`due_date IS NOT NULL`]
        if (input.from !== undefined) bounds.push(sql`due_date >= ${input.from}`)
        if (input.before !== undefined) bounds.push(sql`due_date < ${input.before}`)
        const rows = yield* sql<TaskRow>`
          SELECT ${sql.literal(TASK_COLUMNS)} FROM tasks
          WHERE ${visibleScope(input)}
            AND status != 'done'
            AND ${sql.and(bounds)}
          ORDER BY ${sql.literal(bucketOrder)}
        `
        return rows.map(toTask)
      })

    /**
     * The missing due-instant bucket query (ticket #36): timed rows in
     * `[from, before)` as UTC ISO instants. The service derives these bounds
     * from zoned day starts, so DST days are 23/25 hours here.
     */
    const listDueInstantRange = (input: {
      readonly householdId: string
      readonly userId: UserId
      readonly from?: string
      readonly before?: string
    }) =>
      Effect.gen(function*() {
        const bounds: Array<Statement.Fragment> = [sql`due_at IS NOT NULL`]
        if (input.from !== undefined) bounds.push(sql`due_at >= ${input.from}`)
        if (input.before !== undefined) bounds.push(sql`due_at < ${input.before}`)
        const rows = yield* sql<TaskRow>`
          SELECT ${sql.literal(TASK_COLUMNS)} FROM tasks
          WHERE ${visibleScope(input)}
            AND status != 'done'
            AND ${sql.and(bounds)}
          ORDER BY ${sql.literal(bucketOrder)}
        `
        return rows.map(toTask)
      })

    /** Live, non-done rows with neither due shape. */
    const listNoDue = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<TaskRow>`
          SELECT ${sql.literal(TASK_COLUMNS)} FROM tasks
          WHERE ${visibleScope(input)}
            AND status != 'done'
            AND due_at IS NULL AND due_date IS NULL
          ORDER BY ${sql.literal(bucketOrder)}
        `,
        (rows) => rows.map(toTask)
      )

    /**
     * Live recurring rows, regardless of due date (ticket #43).
     *
     * The week/month read models need the series' anchor — which may be months
     * before the requested range — to project future occurrences with the #38
     * engine. A due-date range query alone would miss it, so this is a narrow,
     * index-friendly second read instead of scanning every past task.
     */
    const listRecurringLive = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<TaskRow>`
          SELECT ${sql.literal(TASK_COLUMNS)} FROM tasks
          WHERE ${visibleScope(input)}
            AND status != 'done'
            AND recurrence IS NOT NULL
          ORDER BY due_date IS NULL, due_date ASC, due_at ASC, id ASC
        `,
        (rows) => rows.map(toTask)
      )

    /**
     * "Today"/overdue buckets read by local due day, never by the server clock.
     *
     * `status` and `priority` are TEXT enums, so alphabetical order would put
     * `done` ahead of `todo` and `low` ahead of `medium`; the CASE ranks pin
     * lifecycle (todo → doing → done) and importance (high → medium → low).
     */
    const listDueOn = (input: {
      readonly householdId: string
      readonly userId: UserId
      readonly dueDate: string
    }) =>
      Effect.map(
        sql<TaskRow>`
          SELECT ${sql.literal(TASK_COLUMNS)} FROM tasks
          WHERE ${visibleScope(input)}
            AND due_date = ${input.dueDate}
          ORDER BY
            CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END,
            CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
            id ASC
        `,
        (rows) => rows.map(toTask)
      )

    const insert = (task: Task) =>
      Effect.map(
        sql<TaskRow>`
          INSERT INTO tasks
            (id, type, title, description, owner_id, household_id, visibility,
             status, priority, due_at, due_date, time_zone, project_id, tag_ids,
             color, recurrence, recurrence_mode, started_at, completed_at,
             created_at, updated_at, version, deleted_at)
          VALUES
            (${task.id}, ${task.type}, ${task.title}, ${task.description},
             ${task.ownerId}, ${task.householdId}, ${task.visibility},
             ${task.status}, ${task.priority}, ${task.dueAt}, ${task.dueDate},
             ${task.timeZone}, ${task.projectId}, ${encodeTagIds(task.tagIds)},
             ${task.color}, ${encodeRecurrence(task.recurrence)},
             ${task.recurrenceMode}, ${task.startedAt}, ${task.completedAt},
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
            recurrence = ${encodeRecurrence(task.recurrence)},
            recurrence_mode = ${task.recurrenceMode},
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

    /**
     * Task tag-join statements for a service mutation. They are gated on the
     * task row's *new* version + update timestamp, so a lost CAS (which writes
     * nothing) cannot leave the join table ahead of the row. `item_tags`
     * remains canonical; `tasks.tag_ids` is its denormalized mirror.
     */
    const detachTagsIfVersion = (input: {
      readonly taskId: string
      readonly version: number
      readonly updatedAt: string
    }) =>
      sql`
        DELETE FROM item_tags
        WHERE item_id = ${input.taskId} AND item_type = 'task'
          AND EXISTS (
            SELECT 1 FROM tasks
            WHERE id = ${input.taskId}
              AND version = ${input.version}
              AND updated_at = ${input.updatedAt}
          )
      `

    const attachTagIfVersion = (input: {
      readonly taskId: string
      readonly tagId: TagId
      readonly householdId: string
      readonly createdAt: string
      readonly version: number
      readonly updatedAt: string
    }) =>
      sql`
        INSERT INTO item_tags (item_id, item_type, tag_id, household_id, created_at)
        SELECT ${input.taskId}, 'task', ${input.tagId}, ${input.householdId}, ${input.createdAt}
        WHERE EXISTS (
          SELECT 1 FROM tasks
          WHERE id = ${input.taskId}
            AND version = ${input.version}
            AND updated_at = ${input.updatedAt}
        )
        ON CONFLICT DO NOTHING
      `

    /** Statement form so the sync engine can put the write in one batch. */
    const insertStatement = (task: Task) => sql`
      INSERT INTO tasks
        (id, type, title, description, owner_id, household_id, visibility,
         status, priority, due_at, due_date, time_zone, project_id, tag_ids,
         color, recurrence, recurrence_mode, started_at, completed_at,
         created_at, updated_at, version, deleted_at)
      VALUES
        (${task.id}, ${task.type}, ${task.title}, ${task.description},
         ${task.ownerId}, ${task.householdId}, ${task.visibility},
         ${task.status}, ${task.priority}, ${task.dueAt}, ${task.dueDate},
         ${task.timeZone}, ${task.projectId}, ${encodeTagIds(task.tagIds)},
         ${task.color}, ${encodeRecurrence(task.recurrence)},
         ${task.recurrenceMode}, ${task.startedAt}, ${task.completedAt},
         ${task.createdAt}, ${task.updatedAt}, ${task.version}, ${task.deletedAt})
      ON CONFLICT DO NOTHING
    `

    /**
     * A statement-form insert that only lands when `gate` holds.
     *
     * Used by the occasion preparation task (#59): the task is inserted in the
     * same batch as the occasion's CAS that links it, gated on that exact
     * occasion version and link, so a lost CAS cannot leave an orphan task. The
     * caller owns the gate fragment; it binds only parameters.
     */
    const insertStatementGated = (task: Task, gate: Statement.Fragment) => sql`
      INSERT INTO tasks
        (id, type, title, description, owner_id, household_id, visibility,
         status, priority, due_at, due_date, time_zone, project_id, tag_ids,
         color, recurrence, recurrence_mode, started_at, completed_at,
         created_at, updated_at, version, deleted_at)
      SELECT
        ${task.id}, ${task.type}, ${task.title}, ${task.description},
        ${task.ownerId}, ${task.householdId}, ${task.visibility},
        ${task.status}, ${task.priority}, ${task.dueAt}, ${task.dueDate},
        ${task.timeZone}, ${task.projectId}, ${encodeTagIds(task.tagIds)},
        ${task.color}, ${encodeRecurrence(task.recurrence)},
        ${task.recurrenceMode}, ${task.startedAt}, ${task.completedAt},
        ${task.createdAt}, ${task.updatedAt}, ${task.version}, ${task.deletedAt}
      WHERE ${gate}
      ON CONFLICT DO NOTHING
    `

    /**
     * The next occurrence of a recurring task (ticket #38), inserted in the
     * same batch as the completion that spawned it.
     *
     * The insert only lands when the parent really reached `done` at the
     * version the service read, so a completion that loses its version CAS
     * cannot leave an orphan successor. The partial unique index on
     * `recurrence_parent_id` (and `ON CONFLICT DO NOTHING`) makes the spawn
     * exactly-once even if the same instance is completed again after an undo:
     * one instance has at most one successor, ever.
     */
    const insertRecurrenceChildStatement = (input: {
      readonly task: Task
      readonly parentId: TaskId
      readonly parentVersion: number
    }) => sql`
      INSERT INTO tasks
        (id, type, title, description, owner_id, household_id, visibility,
         status, priority, due_at, due_date, time_zone, project_id, tag_ids,
         color, recurrence, recurrence_mode, recurrence_parent_id,
         started_at, completed_at, created_at, updated_at, version, deleted_at)
      SELECT
        ${input.task.id}, ${input.task.type}, ${input.task.title},
        ${input.task.description}, ${input.task.ownerId}, ${input.task.householdId},
        ${input.task.visibility}, ${input.task.status}, ${input.task.priority},
        ${input.task.dueAt}, ${input.task.dueDate}, ${input.task.timeZone},
        ${input.task.projectId}, ${encodeTagIds(input.task.tagIds)},
        ${input.task.color}, ${encodeRecurrence(input.task.recurrence)},
        ${input.task.recurrenceMode}, ${input.parentId},
        ${input.task.startedAt}, ${input.task.completedAt}, ${input.task.createdAt},
        ${input.task.updatedAt}, ${input.task.version}, ${input.task.deletedAt}
      WHERE EXISTS (
        SELECT 1 FROM tasks
        WHERE id = ${input.parentId}
          AND version = ${input.parentVersion}
          AND status = 'done'
      )
      ON CONFLICT DO NOTHING
    `

    return {
      findById,
      listVisible,
      listFiltered,
      listDueDateRange,
      listDueInstantRange,
      listNoDue,
      listDueOn,
      listRecurringLive,
      detachTagsIfVersion,
      attachTagIfVersion,
      insert,
      update,
      insertStatement,
      insertStatementGated,
      insertRecurrenceChildStatement
    } as const
  })
}) {}

export const TaskRepoLive = Layer.effect(TaskRepo, TaskRepo.make)
