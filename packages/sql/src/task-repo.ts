import { Context, Effect, Layer, Option, Schema } from 'effect'
import { SqlClient, Statement } from 'effect/sql'
import {
  type Priority,
  type ProjectId,
  RecurrenceRule,
  TagId,
  Task,
  type TaskId,
  type TaskStatus,
  type UserId,
} from '@tali/domain'
import {
  type ColumnValues,
  column,
  columnCodecs,
  defineTable,
  insertStatement,
  selectList,
  updateStatement,
} from './columns'
import { visibleScopeSql } from './scope'

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

/**
 * The one place `tasks`' columns are declared (#115): the repo's SELECT,
 * INSERT and UPDATE lists below, and the sync registry's projection and
 * statements (spawned successors included), are all generated from this
 * descriptor. `recurrence_parent_id` is not here — it is a spawn-only column,
 * bound as an `extra` by the statements that write it.
 */
export const TASK_TABLE = defineTable('tasks', [
  column('id', { updatable: false }),
  column('type', { updatable: false }),
  column('title', { codec: columnCodecs.text }),
  column('description', { codec: columnCodecs.nullableText }),
  column('owner_id', 'ownerId', { updatable: false }),
  column('household_id', 'householdId', { updatable: false }),
  column('visibility'),
  column('status', { codec: columnCodecs.text }),
  column('priority', { codec: columnCodecs.text }),
  column('due_at', 'dueAt', { codec: columnCodecs.nullableText }),
  column('due_date', 'dueDate', { codec: columnCodecs.nullableText }),
  column('time_zone', 'timeZone', { codec: columnCodecs.text }),
  column('project_id', 'projectId', { codec: columnCodecs.nullableText }),
  column('tag_ids', 'tagIds', { codec: columnCodecs.json }),
  column('color', { codec: columnCodecs.nullableText }),
  column('recurrence', { codec: columnCodecs.jsonOrNull }),
  column('recurrence_mode', 'recurrenceMode', {
    codec: columnCodecs.nullableText,
  }),
  column('started_at', 'startedAt', { codec: columnCodecs.nullableText }),
  column('completed_at', 'completedAt', { codec: columnCodecs.nullableText }),
  column('created_at', 'createdAt', {
    updatable: false,
    codec: columnCodecs.text,
  }),
  column('updated_at', 'updatedAt', { codec: columnCodecs.text }),
  column('version', { codec: columnCodecs.int }),
  column('deleted_at', 'deletedAt', { codec: columnCodecs.nullableText }),
])

const TASK_SELECT = selectList(TASK_TABLE)

interface TaskRow extends Omit<Task, 'tagIds' | 'recurrence'> {
  readonly tagIds: string
  /** JSON text in SQLite; parsed into the structured rule by `toTask`. */
  readonly recurrence: string | null
}

const asTagIds = Schema.decodeOption(Schema.fromJsonString(Schema.Array(TagId)))

const asRecurrence = Schema.decodeOption(
  Schema.fromJsonString(Schema.NullOr(RecurrenceRule)),
)

const toTask = (row: TaskRow): Task =>
  new Task({
    ...row,
    tagIds: Option.getOrElse(asTagIds(row.tagIds), () => []),
    recurrence:
      row.recurrence === null
        ? null
        : Option.getOrThrow(asRecurrence(row.recurrence)),
  })

/** The model's column values; the descriptor's codecs do the encoding. */
const taskValues = (task: Task): ColumnValues<typeof TASK_TABLE> => ({
  id: task.id,
  type: task.type,
  title: task.title,
  description: task.description,
  ownerId: task.ownerId,
  householdId: task.householdId,
  visibility: task.visibility,
  status: task.status,
  priority: task.priority,
  dueAt: task.dueAt,
  dueDate: task.dueDate,
  timeZone: task.timeZone,
  projectId: task.projectId,
  tagIds: task.tagIds,
  color: task.color,
  recurrence: task.recurrence,
  recurrenceMode: task.recurrenceMode,
  startedAt: task.startedAt,
  completedAt: task.completedAt,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  version: task.version,
  deletedAt: task.deletedAt,
})

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
    readonly by:
      | 'dueDate'
      | 'priority'
      | 'status'
      | 'createdAt'
      | 'updatedAt'
      | 'title'
    readonly direction: 'asc' | 'desc'
  }
}

/**
 * Static, trusted ORDER BY fragments. A sort field/direction is validated by
 * the contract's literal schema; client values are never interpolated. The
 * trailing `id ASC` is the stable tiebreak for equal keys.
 */
const orderBy = (sort: NonNullable<TaskQuery['sort']>): string => {
  const direction = sort.direction === 'desc' ? 'DESC' : 'ASC'
  switch (sort.by) {
    case 'priority':
      return `CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ${direction},
        CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END ASC,
        due_date IS NULL, due_date ASC, due_at ASC, id ASC`
    case 'status':
      return `CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END ${direction},
        CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC,
        due_date IS NULL, due_date ASC, due_at ASC, id ASC`
    case 'createdAt':
      return `created_at ${direction}, id ASC`
    case 'updatedAt':
      return `updated_at ${direction}, id ASC`
    case 'title':
      return `title COLLATE NOCASE ${direction}, id ASC`
    case 'dueDate':
    default:
      return `due_date IS NULL, due_date ${direction}, due_at ${direction}, id ASC`
  }
}

const bucketOrder = `
  CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC,
  due_date IS NULL, due_date ASC, due_at ASC, id ASC
`

export class TaskRepo extends Context.Service<TaskRepo>()('TaskRepo', {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    /** ADR-0011: the visibility filter every task read shares. */
    const visibleScope = (input: {
      readonly householdId: string
      readonly userId: UserId
    }): Statement.Fragment => visibleScopeSql(sql, input)

    const findById = (id: TaskId) =>
      Effect.map(
        sql<TaskRow>`SELECT ${sql.literal(TASK_SELECT)} FROM tasks WHERE id = ${id}`,
        rows => Option.map(Option.fromUndefinedOr(rows[0]), toTask),
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
          SELECT ${sql.literal(TASK_SELECT)} FROM tasks
          WHERE ${visibleScope(input)}
          ORDER BY due_date IS NULL, due_date ASC, due_at ASC, updated_at DESC
        `,
        rows => rows.map(toTask),
      )

    /**
     * Filter + sort for the task list (FR-TASK-02). All predicates are bound
     * parameters; the only interpolated SQL is the trusted ORDER BY above.
     */
    const listFiltered = (input: TaskQuery) =>
      Effect.gen(function* () {
        const conditions: Array<Statement.Fragment> = [visibleScope(input)]

        if (input.projectId !== undefined) {
          conditions.push(
            input.projectId === null
              ? sql`project_id IS NULL`
              : sql`project_id = ${input.projectId}`,
          )
        }
        if (input.tagIds !== undefined && input.tagIds.length > 0) {
          // "any of these tags" without an `IN` list: D1's compiler treats a
          // qualified `alias.column` passed to `sql.in` as a table name.
          conditions.push(
            sql`(${sql.or(
              input.tagIds.map(
                tagId =>
                  sql`EXISTS (
                  SELECT 1 FROM json_each(tasks.tag_ids) AS jt
                  WHERE jt.value = ${tagId}
                )`,
              ),
            )})`,
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
        if (
          input.includeArchived !== true &&
          input.completionCutoff !== undefined
        ) {
          conditions.push(
            sql`(status != 'done' OR (completed_at IS NOT NULL AND completed_at >= ${input.completionCutoff}))`,
          )
        }

        // A date range and an instant range are alternatives (a task has one
        // due shape), so they are OR'ed rather than AND'ed.
        const dueRanges: Array<Statement.Fragment> = []
        if (
          input.dueDateFrom !== undefined ||
          input.dueDateBefore !== undefined
        ) {
          const parts: Array<Statement.Fragment> = [
            sql`due_at IS NULL`,
            sql`due_date IS NOT NULL`,
          ]
          if (input.dueDateFrom !== undefined) {
            parts.push(sql`due_date >= ${input.dueDateFrom}`)
          }
          if (input.dueDateBefore !== undefined) {
            parts.push(sql`due_date < ${input.dueDateBefore}`)
          }
          dueRanges.push(sql`(${sql.and(parts)})`)
        }
        if (
          input.dueInstantFrom !== undefined ||
          input.dueInstantBefore !== undefined
        ) {
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
          SELECT ${sql.literal(TASK_SELECT)} FROM tasks
          WHERE ${sql.and(conditions)}
          ORDER BY ${sql.literal(orderBy(input.sort ?? { by: 'dueDate', direction: 'asc' }))}
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
      Effect.gen(function* () {
        const bounds: Array<Statement.Fragment> = [
          sql`due_at IS NULL`,
          sql`due_date IS NOT NULL`,
        ]
        if (input.from !== undefined)
          bounds.push(sql`due_date >= ${input.from}`)
        if (input.before !== undefined)
          bounds.push(sql`due_date < ${input.before}`)
        const rows = yield* sql<TaskRow>`
          SELECT ${sql.literal(TASK_SELECT)} FROM tasks
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
      Effect.gen(function* () {
        const bounds: Array<Statement.Fragment> = [sql`due_at IS NOT NULL`]
        if (input.from !== undefined) bounds.push(sql`due_at >= ${input.from}`)
        if (input.before !== undefined)
          bounds.push(sql`due_at < ${input.before}`)
        const rows = yield* sql<TaskRow>`
          SELECT ${sql.literal(TASK_SELECT)} FROM tasks
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
          SELECT ${sql.literal(TASK_SELECT)} FROM tasks
          WHERE ${visibleScope(input)}
            AND status != 'done'
            AND due_at IS NULL AND due_date IS NULL
          ORDER BY ${sql.literal(bucketOrder)}
        `,
        rows => rows.map(toTask),
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
          SELECT ${sql.literal(TASK_SELECT)} FROM tasks
          WHERE ${visibleScope(input)}
            AND status != 'done'
            AND recurrence IS NOT NULL
          ORDER BY due_date IS NULL, due_date ASC, due_at ASC, id ASC
        `,
        rows => rows.map(toTask),
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
          SELECT ${sql.literal(TASK_SELECT)} FROM tasks
          WHERE ${visibleScope(input)}
            AND due_date = ${input.dueDate}
          ORDER BY
            CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END,
            CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
            id ASC
        `,
        rows => rows.map(toTask),
      )

    const insert = (task: Task) =>
      Effect.map(
        insertStatement<TaskRow>(sql, TASK_TABLE, {
          values: taskValues(task),
          returning: TASK_SELECT,
        }),
        rows => toTask(rows[0]!),
      )

    /**
     * Full-row update. The caller owns the version CAS (`WHERE id AND
     * version = base`) in the sync path; this primitive is for service writes
     * that already hold the row.
     */
    const update = (task: Task) =>
      Effect.map(
        updateStatement<TaskRow>(sql, TASK_TABLE, {
          id: task.id,
          values: taskValues(task),
          returning: TASK_SELECT,
        }),
        rows => Option.map(Option.fromUndefinedOr(rows[0]), toTask),
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
    const insertStatementFor = (task: Task) =>
      insertStatement(sql, TASK_TABLE, {
        values: taskValues(task),
        onConflict: true,
      })

    /**
     * A statement-form insert that only lands when `gate` holds.
     *
     * Used by the occasion preparation task (#59): the task is inserted in the
     * same batch as the occasion's CAS that links it, gated on that exact
     * occasion version and link, so a lost CAS cannot leave an orphan task. The
     * caller owns the gate fragment; it binds only parameters.
     */
    const insertStatementGated = (task: Task, gate: Statement.Fragment) =>
      insertStatement(sql, TASK_TABLE, {
        values: taskValues(task),
        gate,
        onConflict: true,
      })

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
    }) =>
      insertStatement(sql, TASK_TABLE, {
        values: taskValues(input.task),
        extra: [{ column: 'recurrence_parent_id', value: input.parentId }],
        gate: sql`
          EXISTS (
            SELECT 1 FROM tasks
            WHERE id = ${input.parentId}
              AND version = ${input.parentVersion}
              AND status = 'done'
          )
        `,
        onConflict: true,
      })

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
      insertStatement: insertStatementFor,
      insertStatementGated,
      insertRecurrenceChildStatement,
    }
  }),
}) {}

export const TaskRepoLive = Layer.effect(TaskRepo, TaskRepo.make)
