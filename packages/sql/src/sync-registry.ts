import { Schema } from "effect"
import { type SqlClient, Statement } from "effect/sql"
import {
  Event,
  Habit,
  HabitEntry,
  HabitFrequency,
  habitFrequencyHistoryAfter,
  type HabitFrequencyChange,
  List,
  localDateIn,
  localDateInOption,
  Note,
  normalizePersian,
  Project,
  sameHabitFrequency,
  Reminder,
  reminderFireAt,
  type ReminderType,
  reminderTierFor,
  successorTask,
  Tag,
  Task,
  type SyncEntityType,
  type Visibility
} from "@tali/domain"

/**
 * The sync entity registry (ticket #34).
 *
 * Before this module the sync engine hard-coded `list_items` for its table,
 * writable fields and hydration. The registry is the single place that maps a
 * `SyncEntityType` to:
 *
 * - the D1 **table** and its trusted column projection (never client input);
 * - the **writable-field allowlist** a client patch may set, with a value
 *   guard per field;
 * - the **hydration codec** (the aggregate's real `Model.Class` from #33, so
 *   the wire payload is validated against the same contract as the repos);
 * - the **household/owner visibility** columns (`household_id`, `owner_id`,
 *   `visibility`) every aggregate shares;
 * - the **soft-delete** column (`deleted_at`);
 * - the `INSERT`/`UPDATE` statement builders the push batch uses.
 *
 * Units are pure metadata plus two statement builders per aggregate. The
 * builders take the row's trusted table/columns from this file and bind every
 * value as a parameter, so a client can never choose a column name.
 *
 * ## The `listItem` compatibility shim
 *
 * `list_items` is the scaffold table from #1, extended in place by
 * `0005_core_planning.sql` with the real ListItem columns (`name`, `done`,
 * `ordering`, `list_id`, `checked_at`, `color`, `tag_ids`, `type`). Two writers
 * still exist: the scaffold repo (`list-item-repo.ts`) writes only
 * `title`/`checked`/`sort_order`, and the real `PlanningListItemRepo` dual-writes
 * both sets.
 *
 * The web mirror (#17/#18) and `/today` read `data.title` / `data.checked` /
 * `data.sortOrder`, and #34 must not change the web app. So the `listItem`
 * entry stays on the **scaffold wire shape** and every sync write **dual-writes
 * both column sets**. Reads use the scaffold columns, which every writer keeps
 * current. Ticket #39 additionally accepts and hydrates the real aggregate
 * names (`name`/`done`/`ordering`), so `/lists` can speak the #33 vocabulary
 * without breaking the legacy `listItem` wire shape.
 */

// ── Row state ─────────────────────────────────────────────────────────────

export interface SyncEntityState {
  readonly entityType: SyncEntityType
  readonly entityId: string
  readonly householdId: string | null
  readonly ownerId: string
  readonly visibility: Visibility
  readonly version: number
  readonly updatedAt: string
  readonly deletedAt: string | null
  readonly data: Record<string, unknown>
}

/** Server-managed fields the domain models require but the wire payload omits. */
export interface SyncEntityMeta {
  readonly version: number
  readonly updatedAt: string
  readonly deletedAt: string | null
}

export type SyncRawRow = Record<string, unknown>

export interface SyncCreateContext {
  readonly entityId: string
  readonly userId: string
  readonly householdId: string
  readonly now: string
  readonly clientUpdatedAt: string
}

export interface SyncMergeInput {
  readonly current: Record<string, unknown>
  readonly patch: Record<string, unknown>
  /** Is the incoming edit newer than the stored `updatedAt` (LWW)? */
  readonly incomingNewer: boolean
  /** True when the push's `baseVersion` was behind the stored row. */
  readonly conflict: boolean
  /** The server's commit instant. */
  readonly now: string
}

/** Fallback LWW merge shared by every aggregate (see `docs/sync-protocol-draft.md` §6). */
export interface SyncMergeDefaults {
  readonly current: Record<string, unknown>
  readonly patch: Record<string, unknown>
  readonly incomingNewer: boolean
  readonly conflict: boolean
}

export type SyncFieldGuard = (value: unknown) => boolean

/** The scope columns every aggregate shares (pull/bootstrap filtering). */
export interface SyncScopeColumns {
  readonly householdId: string
  readonly ownerId: string
  readonly visibility: string
}

export const SYNC_SCOPE_COLUMNS: SyncScopeColumns = {
  householdId: "household_id",
  ownerId: "owner_id",
  visibility: "visibility"
}

export interface SyncEntityDefinition {
  readonly entityType: SyncEntityType
  readonly table: string
  /** Trusted SELECT list: physical columns aliased to the camelCase wire names. */
  readonly select: string
  /** Household/owner scoping columns (identical across aggregates today). */
  readonly scope: SyncScopeColumns
  /** Soft-delete tombstone column (`deleted_at` across aggregates today). */
  readonly softDeleteColumn: string
  /** Client-patchable fields and their value guards. */
  readonly writable: ReadonlyMap<string, SyncFieldGuard>
  /**
   * Fields whose presence with an invalid value must **reject** the entry
   * instead of being dropped by the sanitizer (the shared default). Used where a
   * dropped value would silently write something the user did not ask for —
   * a habit entry's day, habit or status (#63).
   */
  readonly strict?: ReadonlyArray<string>
  /** Done-wins: the field + value that a completion beats a concurrent edit with. */
  readonly completion?: { readonly field: string; readonly value: unknown }
  /** Data for an offline insert, before validation. */
  readonly defaults: (
    patch: Record<string, unknown>,
    context: SyncCreateContext
  ) => Record<string, unknown>
  /** D1 row → data payload (best-effort: tombstones may not satisfy the model). */
  readonly hydrate: (row: SyncRawRow) => Record<string, unknown>
  /** Strict decode boundary for client-authored data; throws a `SchemaError`. */
  readonly validate: (
    data: Record<string, unknown>,
    meta: SyncEntityMeta
  ) => Record<string, unknown>
  /** Merge a patch into the stored data (§6 LWW + completion). */
  readonly merge: (input: SyncMergeInput) => Record<string, unknown>
  readonly insert: (state: SyncEntityState) => Statement.Statement<unknown>
  readonly update: (
    state: SyncEntityState,
    expectedVersion: number
  ) => Statement.Statement<unknown>
  /**
   * Optional statements that maintain a derived index next to the row (the
   * note search index, #41).
   *
   * They run **after** the entity write, in the same batch, and every one of
   * them is gated on the row reaching the version this write stamped: if the
   * compare-and-set lost, the index keeps the text it already has instead of
   * describing a row that never landed.
   */
  readonly index?: (state: SyncEntityState) => ReadonlyArray<Statement.Statement<unknown>>
  /**
   * Optional parent row this entity belongs to (a habit entry logs a habit).
   *
   * The engine resolves it before planning a write so a child can never carry a
   * wider visibility than its parent or point at another household's row, even
   * when the client forgets to send `visibility`.
   */
  readonly parent?: SyncParentRule
  /**
   * Optional server-side successor for a write (task recurrence, #38).
   *
   * The push calls this **once per entry**, with the row state before and after
   * the merge, and appends the returned insert + feed + ledger in the same
   * batch. `insert` must be gated on the parent reaching `parentVersion`, so a
   * completion whose CAS lost can never leave an orphan successor.
   */
  readonly spawn?: (input: SyncSpawnInput) => SyncSpawn | undefined
}

/** A parent reference resolved by the sync engine (see `parent` above). */
export interface SyncParentRule {
  /** Aggregate type of the parent row. */
  readonly entityType: SyncEntityType
  /** Data/patch field naming the parent id. */
  readonly field: string
  /** Copy the parent's visibility onto the child on every write. */
  readonly inheritVisibility: boolean
}

export interface SyncSpawnInput {
  /** The row before this entry; `undefined` for an insert. */
  readonly previous: SyncEntityState | undefined
  /** The row this entry writes (already merged and validated). */
  readonly next: SyncEntityState
  readonly now: string
}

export interface SyncSpawn {
  /** The already-validated successor row. */
  readonly state: SyncEntityState
  /** The completed instance this successor belongs to. */
  readonly parentId: string
  /** The parent version the insert is gated on (the write's new version). */
  readonly parentVersion: number
  /** Gated child INSERT; must run immediately before the child feed append. */
  readonly insert: (state: SyncEntityState) => Statement.Statement<unknown>
  /** Child `item_tags` joins, run after the feed/ledger (gated on the child row). */
  readonly joins?: (state: SyncEntityState) => ReadonlyArray<Statement.Statement<unknown>>
}

export interface SyncRegistry {
  readonly get: (entityType: SyncEntityType) => SyncEntityDefinition | undefined
  readonly all: () => ReadonlyArray<SyncEntityDefinition>
}

// ── Value codecs (D1 has no boolean/nullable types beyond SQLite's affinity) ─

/** A JSON array/object column or a JSON scalar; stored as TEXT. */
const encodeJson = (value: unknown): string => JSON.stringify(value ?? null)
const encodeText = (value: unknown): string => (typeof value === "string" ? value : "")
const encodeNullableText = (value: unknown): string | null =>
  typeof value === "string" ? value : null
const encodeInt = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0
const encodeBit = (value: unknown): number => (value === true ? 1 : 0)
const encodeJsonOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : encodeJson(value)

const asBit = (value: unknown): boolean => value === true || value === 1
const asText = (value: unknown): string | null =>
  typeof value === "string" ? value : null
const asVisibility = (value: unknown): Visibility => (value === "private" ? "private" : "shared")
const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value ?? null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
const asStringArray = (value: unknown): ReadonlyArray<string> => {
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : []
}

// ── Field guards (client patches) ─────────────────────────────────────────

const isString: SyncFieldGuard = (value) => typeof value === "string"
const isNullableString: SyncFieldGuard = (value) =>
  value === null || typeof value === "string"
const isBoolean: SyncFieldGuard = (value) => typeof value === "boolean"
const isInt: SyncFieldGuard = (value) => typeof value === "number" && Number.isInteger(value)
const isStringArray: SyncFieldGuard = (value) =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
const isOneOf = (...allowed: ReadonlyArray<string>): SyncFieldGuard => (value) =>
  typeof value === "string" && allowed.includes(value)
const isNullableOneOf = (...allowed: ReadonlyArray<string>): SyncFieldGuard => (value) =>
  value === null || (typeof value === "string" && allowed.includes(value))
const isJson: SyncFieldGuard = (value) => {
  if (value === null || value === undefined) return true
  const kind = typeof value
  return kind === "string" || kind === "number" || kind === "boolean" || kind === "object"
}
const isJsonArray: SyncFieldGuard = (value) => Array.isArray(value)
/** Local calendar date `YYYY-MM-DD` (a habit entry's day). */
const isLocalDate: SyncFieldGuard = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)

// ── Generic merge / hydrate helpers ───────────────────────────────────────

const mergeFields = (
  definition: Pick<SyncEntityDefinition, "completion">,
  input: SyncMergeDefaults
): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...input.current }
  // A fast-path patch is authoritative (the client wrote against the version we
  // hold). On a conflict only a newer `clientUpdatedAt` wins the fields it
  // touched; untouched fields keep the server value.
  if (!input.conflict || input.incomingNewer) Object.assign(next, input.patch)
  if (input.conflict && definition.completion !== undefined) {
    const { field, value } = definition.completion
    if (input.current[field] === value || input.patch[field] === value) next[field] = value
  }
  return next
}

const stripServerFields = (data: Record<string, unknown>): Record<string, unknown> => {
  const copy = { ...data }
  delete copy.version
  delete copy.updatedAt
  delete copy.deletedAt
  return copy
}

/**
 * Bind an aggregate's real #33 schema as the hydration/decode boundary.
 *
 * `normalize` maps a D1 row into the model's plain shape (0/1 booleans, JSON
 * TEXT columns). `validate` is strict and used for client-authored data;
 * `hydrate` is best-effort because a tombstone inserted from a delete-only
 * patch may not satisfy the aggregate's field constraints — the envelope still
 * carries `deletedAt`, so the client drops the row regardless.
 */
const withSchema = <A>(
  schema: Schema.Top,
  normalize: (row: SyncRawRow) => Record<string, unknown>
): Pick<SyncEntityDefinition, "hydrate" | "validate"> => {
  const encode = (value: A): Record<string, unknown> =>
    stripServerFields(Schema.encodeSync(schema as never)(value as never) as Record<string, unknown>)
  const metaOf = (row: SyncRawRow): SyncEntityMeta => ({
    version: encodeInt(row.version),
    updatedAt: encodeText(row.updatedAt),
    deletedAt: asText(row.deletedAt)
  })
  return {
    validate: (data, meta) => {
      const decoded = Schema.decodeUnknownSync(schema as never)({
        ...data,
        ...meta
      } as never) as A
      return encode(decoded)
    },
    hydrate: (row) => {
      const data = normalize(row)
      const decoded = Schema.decodeUnknownOption(schema as never)({
        ...data,
        ...metaOf(row)
      } as never)
      return decoded._tag === "Some" ? encode(decoded.value as A) : data
    }
  }
}

// ── Shared column projection ──────────────────────────────────────────────

const META_COLUMNS =
  `id, owner_id AS ownerId, household_id AS householdId, visibility, version, ` +
  `updated_at AS updatedAt, deleted_at AS deletedAt`

// ── Task ──────────────────────────────────────────────────────────────────

const TASK_COLUMNS =
  `${META_COLUMNS}, type, title, description, status, priority, ` +
  `due_at AS dueAt, due_date AS dueDate, time_zone AS timeZone, ` +
  `project_id AS projectId, tag_ids AS tagIds, color, ` +
  `recurrence, recurrence_mode AS recurrenceMode, ` +
  `started_at AS startedAt, completed_at AS completedAt, created_at AS createdAt`

const taskCodec = withSchema<Task>(Task, (row) => ({
  id: String(row.id),
  type: "task",
  title: encodeText(row.title),
  description: asText(row.description),
  status: encodeText(row.status),
  priority: encodeText(row.priority),
  dueAt: asText(row.dueAt),
  dueDate: asText(row.dueDate),
  timeZone: encodeText(row.timeZone),
  projectId: asText(row.projectId),
  tagIds: asStringArray(row.tagIds),
  color: asText(row.color),
  recurrence: parseJson(row.recurrence),
  recurrenceMode: asText(row.recurrenceMode),
  startedAt: asText(row.startedAt),
  completedAt: asText(row.completedAt),
  ownerId: encodeText(row.ownerId),
  householdId: encodeText(row.householdId),
  visibility: asVisibility(row.visibility),
  createdAt: encodeText(row.createdAt)
}))

/**
 * The gated child `INSERT` for a spawn (task recurrence, #38). It only lands
 * when the parent row really reached `done` at the write's new version; a lost
 * CAS leaves no orphan. `recurrence_parent_id` is not part of the wire schema,
 * so this statement is the only writer of that internal column on the push
 * path. The partial unique index on the column makes it at-most-once.
 */
const insertSpawnedTask = (
  sql: SqlClient.SqlClient,
  state: SyncEntityState,
  parentId: string,
  parentVersion: number
) => sql`
  INSERT INTO tasks
    (id, type, title, description, owner_id, household_id, visibility,
     status, priority, due_at, due_date, time_zone, project_id, tag_ids,
     color, recurrence, recurrence_mode, recurrence_parent_id,
     started_at, completed_at, created_at, updated_at, version, deleted_at)
  SELECT
    ${state.entityId}, ${state.entityType}, ${encodeText(state.data.title)},
    ${encodeNullableText(state.data.description)}, ${state.ownerId},
    ${state.householdId}, ${state.visibility}, ${encodeText(state.data.status)},
    ${encodeText(state.data.priority)}, ${encodeNullableText(state.data.dueAt)},
    ${encodeNullableText(state.data.dueDate)}, ${encodeText(state.data.timeZone)},
    ${encodeNullableText(state.data.projectId)}, ${encodeJson(state.data.tagIds)},
    ${encodeNullableText(state.data.color)},
    ${encodeJsonOrNull(state.data.recurrence)},
    ${encodeNullableText(state.data.recurrenceMode)}, ${parentId},
    ${encodeNullableText(state.data.startedAt)},
    ${encodeNullableText(state.data.completedAt)},
    ${encodeNullableText(state.data.createdAt) ?? state.updatedAt},
    ${state.updatedAt}, ${state.version}, ${state.deletedAt}
  WHERE EXISTS (
    SELECT 1 FROM tasks
    WHERE id = ${parentId}
      AND version = ${parentVersion}
      AND status = 'done'
  )
  ON CONFLICT DO NOTHING
`

const TASK_WRITABLE: ReadonlyMap<string, SyncFieldGuard> = new Map([
  ["title", isString],
  ["description", isNullableString],
  ["status", isOneOf("todo", "doing", "done")],
  ["priority", isOneOf("high", "medium", "low")],
  ["dueAt", isNullableString],
  ["dueDate", isNullableString],
  ["timeZone", isString],
  ["projectId", isNullableString],
  ["tagIds", isStringArray],
  ["color", isNullableString],
  // The rule object is validated structurally by the Task schema below; the
  // guard only rejects non-JSON scalars.
  ["recurrence", isJson],
  ["recurrenceMode", isNullableOneOf("onCompletion", "onDueDate")],
  ["visibility", isOneOf("private", "shared")]
])

/** Tag joins for a freshly spawned successor, gated on the inserted row. */
const spawnedTaskTagJoins = (
  sql: SqlClient.SqlClient,
  state: SyncEntityState
): ReadonlyArray<Statement.Statement<unknown>> =>
  state.householdId === null
    ? []
    : asStringArray(state.data.tagIds).flatMap((tagId) => [
      sql`
        INSERT INTO item_tags (item_id, item_type, tag_id, household_id, created_at)
        SELECT ${state.entityId}, 'task', ${tagId}, ${state.householdId}, ${state.updatedAt}
        WHERE EXISTS (
          SELECT 1 FROM tasks
          WHERE id = ${state.entityId}
            AND version = ${state.version}
            AND updated_at = ${state.updatedAt}
        )
        AND EXISTS (SELECT 1 FROM tags WHERE id = ${tagId})
        ON CONFLICT DO NOTHING
      `
    ])

// A completed task beats a concurrent rename, like a checked list item.
const TASK_COMPLETION = { field: "status", value: "done" } as const

const taskDefinition = (sql: SqlClient.SqlClient): SyncEntityDefinition => ({
  entityType: "task",
  table: "tasks",
  select: TASK_COLUMNS,
  scope: SYNC_SCOPE_COLUMNS,
  softDeleteColumn: "deleted_at",
  writable: TASK_WRITABLE,
  completion: TASK_COMPLETION,
  ...taskCodec,
  defaults: (patch, context) => ({
    id: context.entityId,
    type: "task",
    title: encodeText(patch.title),
    description: asText(patch.description),
    status: encodeText(patch.status) || "todo",
    priority: encodeText(patch.priority) || "medium",
    dueAt: asText(patch.dueAt),
    dueDate: asText(patch.dueDate),
    timeZone: encodeText(patch.timeZone) || "UTC",
    projectId: asText(patch.projectId),
    tagIds: Array.isArray(patch.tagIds) ? patch.tagIds : [],
    color: asText(patch.color),
    recurrence: patch.recurrence ?? null,
    recurrenceMode: patch.recurrence === null || patch.recurrence === undefined
      ? null
      : patch.recurrenceMode === "onCompletion" || patch.recurrenceMode === "onDueDate"
      ? patch.recurrenceMode
      : "onDueDate",
    startedAt: null,
    completedAt: null,
    ownerId: context.userId,
    householdId: context.householdId,
    visibility: asVisibility(patch.visibility),
    createdAt: asText(patch.createdAt) ?? context.clientUpdatedAt
  }),
  merge: (input) => {
    const next = mergeFields({ completion: TASK_COMPLETION }, input)
    // Recurrence rule and mode are one unit: a rule without a mode defaults to
    // the fixed schedule, and clearing the rule clears the mode. This keeps a
    // partial client patch from leaving a half-configured series.
    if (next.recurrence === null || next.recurrence === undefined) {
      next.recurrence = null
      next.recurrenceMode = null
    } else if (next.recurrenceMode !== "onCompletion" && next.recurrenceMode !== "onDueDate") {
      next.recurrenceMode = "onDueDate"
    }
    // Lifecycle stamps are server-side (FR-TASK-02). #36 owns the task
    // service; sync keeps the same rule so an offline completion is coherent.
    if (next.status === "done") {
      if (next.completedAt === null) next.completedAt = input.now
    } else {
      next.completedAt = null
    }
    if (next.status === "doing" && next.startedAt === null) next.startedAt = input.now
    return next
  },
  /**
   * Server-side successor generation for an offline completion (#38). Runs
   * only on a live transition into `done`; `successorTask` is the same builder
   * `TaskService` uses, so the date/mode semantics cannot drift between the
   * RPC and sync paths.
   */
  spawn: ({ previous, next, now }) => {
    if (next.deletedAt !== null) return undefined
    if (previous === undefined) return undefined
    if (previous.data.status === "done" || next.data.status !== "done") return undefined

    const completed = new Task({
      ...next.data,
      id: next.entityId,
      version: next.version,
      updatedAt: next.updatedAt,
      deletedAt: next.deletedAt
    } as never)
    const child = successorTask(completed, now)
    if (child === null) return undefined
    const state: SyncEntityState = {
      entityType: "task",
      entityId: child.id,
      householdId: child.householdId,
      ownerId: child.ownerId,
      visibility: child.visibility,
      version: child.version,
      updatedAt: child.updatedAt,
      deletedAt: null,
      data: taskCodec.validate(
        { ...child } as Record<string, unknown>,
        { version: child.version, updatedAt: child.updatedAt, deletedAt: null }
      )
    }
    return {
      parentId: next.entityId,
      parentVersion: next.version,
      state,
      insert: (childState) => insertSpawnedTask(sql, childState, next.entityId, next.version),
      joins: (childState) => spawnedTaskTagJoins(sql, childState)
    }
  },
  insert: (state) => sql`
    INSERT INTO tasks
      (id, type, title, description, owner_id, household_id, visibility,
       status, priority, due_at, due_date, time_zone, project_id, tag_ids,
       color, recurrence, recurrence_mode, started_at, completed_at,
       created_at, updated_at, version, deleted_at)
    VALUES
      (${state.entityId}, ${state.entityType}, ${encodeText(state.data.title)},
       ${encodeNullableText(state.data.description)}, ${state.ownerId},
       ${state.householdId}, ${state.visibility}, ${encodeText(state.data.status)},
       ${encodeText(state.data.priority)}, ${encodeNullableText(state.data.dueAt)},
       ${encodeNullableText(state.data.dueDate)}, ${encodeText(state.data.timeZone)},
       ${encodeNullableText(state.data.projectId)}, ${encodeJson(state.data.tagIds)},
       ${encodeNullableText(state.data.color)},
       ${encodeJsonOrNull(state.data.recurrence)},
       ${encodeNullableText(state.data.recurrenceMode)},
       ${encodeNullableText(state.data.startedAt)},
       ${encodeNullableText(state.data.completedAt)},
       ${encodeNullableText(state.data.createdAt) ?? state.updatedAt},
       ${state.updatedAt}, ${state.version}, ${state.deletedAt})
    ON CONFLICT DO NOTHING
  `,
  update: (state, expectedVersion) => sql`
    UPDATE tasks SET
      title = ${encodeText(state.data.title)},
      description = ${encodeNullableText(state.data.description)},
      visibility = ${state.visibility},
      status = ${encodeText(state.data.status)},
      priority = ${encodeText(state.data.priority)},
      due_at = ${encodeNullableText(state.data.dueAt)},
      due_date = ${encodeNullableText(state.data.dueDate)},
      time_zone = ${encodeText(state.data.timeZone)},
      project_id = ${encodeNullableText(state.data.projectId)},
      tag_ids = ${encodeJson(state.data.tagIds)},
      color = ${encodeNullableText(state.data.color)},
      recurrence = ${encodeJsonOrNull(state.data.recurrence)},
      recurrence_mode = ${encodeNullableText(state.data.recurrenceMode)},
      started_at = ${encodeNullableText(state.data.startedAt)},
      completed_at = ${encodeNullableText(state.data.completedAt)},
      updated_at = ${state.updatedAt},
      version = ${state.version},
      deleted_at = ${state.deletedAt}
    WHERE id = ${state.entityId} AND version = ${expectedVersion}
  `
})

// ── Project ───────────────────────────────────────────────────────────────

const PROJECT_COLUMNS =
  `${META_COLUMNS}, type, title, color, created_at AS createdAt`

const projectCodec = withSchema<Project>(Project, (row) => ({
  id: String(row.id),
  type: "project",
  title: encodeText(row.title),
  ownerId: encodeText(row.ownerId),
  householdId: encodeText(row.householdId),
  visibility: asVisibility(row.visibility),
  color: asText(row.color),
  createdAt: encodeText(row.createdAt)
}))

const projectDefinition = (sql: SqlClient.SqlClient): SyncEntityDefinition => ({
  entityType: "project",
  table: "projects",
  select: PROJECT_COLUMNS,
  scope: SYNC_SCOPE_COLUMNS,
  softDeleteColumn: "deleted_at",
  writable: new Map([
    ["title", isString],
    ["color", isNullableString],
    ["visibility", isOneOf("private", "shared")]
  ]),
  ...projectCodec,
  defaults: (patch, context) => ({
    id: context.entityId,
    type: "project",
    title: encodeText(patch.title),
    ownerId: context.userId,
    householdId: context.householdId,
    visibility: asVisibility(patch.visibility),
    color: asText(patch.color),
    createdAt: asText(patch.createdAt) ?? context.clientUpdatedAt
  }),
  merge: (input) => mergeFields({}, input),
  insert: (state) => sql`
    INSERT INTO projects
      (id, type, title, owner_id, household_id, visibility, color,
       created_at, updated_at, version, deleted_at)
    VALUES
      (${state.entityId}, ${state.entityType}, ${encodeText(state.data.title)},
       ${state.ownerId}, ${state.householdId}, ${state.visibility},
       ${encodeNullableText(state.data.color)},
       ${encodeNullableText(state.data.createdAt) ?? state.updatedAt},
       ${state.updatedAt}, ${state.version}, ${state.deletedAt})
    ON CONFLICT DO NOTHING
  `,
  update: (state, expectedVersion) => sql`
    UPDATE projects SET
      title = ${encodeText(state.data.title)},
      visibility = ${state.visibility},
      color = ${encodeNullableText(state.data.color)},
      updated_at = ${state.updatedAt},
      version = ${state.version},
      deleted_at = ${state.deletedAt}
    WHERE id = ${state.entityId} AND version = ${expectedVersion}
  `
})

// ── Tag ───────────────────────────────────────────────────────────────────

const TAG_COLUMNS = `${META_COLUMNS}, type, name, color, created_at AS createdAt`

const tagCodec = withSchema<Tag>(Tag, (row) => ({
  id: String(row.id),
  type: "tag",
  name: encodeText(row.name),
  ownerId: encodeText(row.ownerId),
  householdId: encodeText(row.householdId),
  visibility: asVisibility(row.visibility),
  color: asText(row.color),
  createdAt: encodeText(row.createdAt)
}))

const tagDefinition = (sql: SqlClient.SqlClient): SyncEntityDefinition => ({
  entityType: "tag",
  table: "tags",
  select: TAG_COLUMNS,
  scope: SYNC_SCOPE_COLUMNS,
  softDeleteColumn: "deleted_at",
  writable: new Map([
    ["name", isString],
    ["color", isNullableString],
    ["visibility", isOneOf("private", "shared")]
  ]),
  ...tagCodec,
  defaults: (patch, context) => ({
    id: context.entityId,
    type: "tag",
    name: encodeText(patch.name),
    ownerId: context.userId,
    householdId: context.householdId,
    visibility: asVisibility(patch.visibility),
    color: asText(patch.color),
    createdAt: asText(patch.createdAt) ?? context.clientUpdatedAt
  }),
  merge: (input) => mergeFields({}, input),
  insert: (state) => sql`
    INSERT INTO tags
      (id, type, name, owner_id, household_id, visibility, color,
       created_at, updated_at, version, deleted_at)
    VALUES
      (${state.entityId}, ${state.entityType}, ${encodeText(state.data.name)},
       ${state.ownerId}, ${state.householdId}, ${state.visibility},
       ${encodeNullableText(state.data.color)},
       ${encodeNullableText(state.data.createdAt) ?? state.updatedAt},
       ${state.updatedAt}, ${state.version}, ${state.deletedAt})
    ON CONFLICT DO NOTHING
  `,
  update: (state, expectedVersion) => sql`
    UPDATE tags SET
      name = ${encodeText(state.data.name)},
      visibility = ${state.visibility},
      color = ${encodeNullableText(state.data.color)},
      updated_at = ${state.updatedAt},
      version = ${state.version},
      deleted_at = ${state.deletedAt}
    WHERE id = ${state.entityId} AND version = ${expectedVersion}
  `
})

// ── List ──────────────────────────────────────────────────────────────────

const LIST_COLUMNS =
  `${META_COLUMNS}, type, title, description, color, icon, sort, ` +
  `checked_placement AS checkedPlacement, last_writer_id AS lastWriterId, ` +
  `created_at AS createdAt`

const listSchemaCodec = withSchema<List>(List, (row) => ({
  id: String(row.id),
  type: "list",
  title: encodeText(row.title),
  description: asText(row.description),
  ownerId: encodeText(row.ownerId),
  householdId: encodeText(row.householdId),
  visibility: asVisibility(row.visibility),
  color: asText(row.color),
  icon: asText(row.icon),
  sort: encodeText(row.sort),
  checkedPlacement: encodeText(row.checkedPlacement),
  createdAt: encodeText(row.createdAt)
}))

/**
 * `lastWriterId` is server-managed attribution (#39). It is carried in the
 * hydrated list data for the "updated by" label but is not in the List model or
 * the client-writable allowlist, so a patch can never forge it.
 */
const listCodec = {
  validate: (data: Record<string, unknown>, meta: SyncEntityMeta): Record<string, unknown> => {
    const encoded = listSchemaCodec.validate(data, meta)
    // The List model has no attribution field; keep the server-managed value
    // across the codec so a merge of an untouched row is still a no-op.
    return typeof data.lastWriterId === "string"
      ? { ...encoded, lastWriterId: data.lastWriterId }
      : encoded
  },
  hydrate: (row: SyncRawRow): Record<string, unknown> => ({
    ...listSchemaCodec.hydrate(row),
    lastWriterId: asText(row.lastWriterId)
  })
}

const listDefinition = (sql: SqlClient.SqlClient): SyncEntityDefinition => ({
  entityType: "list",
  table: "lists",
  select: LIST_COLUMNS,
  scope: SYNC_SCOPE_COLUMNS,
  softDeleteColumn: "deleted_at",
  writable: new Map([
    ["title", isString],
    ["description", isNullableString],
    ["color", isNullableString],
    ["icon", isNullableString],
    ["sort", isOneOf("manual", "alpha", "status")],
    ["checkedPlacement", isOneOf("inPlace", "bottom")],
    ["visibility", isOneOf("private", "shared")]
  ]),
  ...listCodec,
  defaults: (patch, context) => ({
    id: context.entityId,
    type: "list",
    title: encodeText(patch.title),
    description: asText(patch.description),
    ownerId: context.userId,
    householdId: context.householdId,
    visibility: asVisibility(patch.visibility),
    color: asText(patch.color),
    icon: asText(patch.icon),
    sort: encodeText(patch.sort) || "manual",
    checkedPlacement: encodeText(patch.checkedPlacement) || "bottom",
    lastWriterId: context.userId,
    createdAt: asText(patch.createdAt) ?? context.clientUpdatedAt
  }),
  merge: (input) => mergeFields({}, input),
  insert: (state) => sql`
    INSERT INTO lists
      (id, type, title, description, owner_id, household_id, visibility,
       color, icon, sort, checked_placement, last_writer_id,
       created_at, updated_at, version, deleted_at)
    VALUES
      (${state.entityId}, ${state.entityType}, ${encodeText(state.data.title)},
       ${encodeNullableText(state.data.description)}, ${state.ownerId},
       ${state.householdId}, ${state.visibility},
       ${encodeNullableText(state.data.color)}, ${encodeNullableText(state.data.icon)},
       ${encodeText(state.data.sort)}, ${encodeText(state.data.checkedPlacement)},
       ${encodeNullableText(state.data.lastWriterId)},
       ${encodeNullableText(state.data.createdAt) ?? state.updatedAt},
       ${state.updatedAt}, ${state.version}, ${state.deletedAt})
    ON CONFLICT DO NOTHING
  `,
  update: (state, expectedVersion) => sql`
    UPDATE lists SET
      title = ${encodeText(state.data.title)},
      description = ${encodeNullableText(state.data.description)},
      visibility = ${state.visibility},
      color = ${encodeNullableText(state.data.color)},
      icon = ${encodeNullableText(state.data.icon)},
      sort = ${encodeText(state.data.sort)},
      checked_placement = ${encodeText(state.data.checkedPlacement)},
      last_writer_id = ${encodeNullableText(state.data.lastWriterId)},
      updated_at = ${state.updatedAt},
      version = ${state.version},
      deleted_at = ${state.deletedAt}
    WHERE id = ${state.entityId} AND version = ${expectedVersion}
  `
})

// ── ListItem (legacy wire shape, dual-write) ──────────────────────────────

const LIST_ITEM_COLUMNS =
  `${META_COLUMNS}, type, title, checked, sort_order AS sortOrder, list_id AS listId, ` +
  `checked_at AS checkedAt, color, tag_ids AS tagIds, ` +
  `last_writer_id AS lastWriterId, created_at AS createdAt`

/**
 * Keep the scaffold wire names (`title`/`checked`/`sortOrder`) and the real
 * #33 names (`name`/`done`/`ordering`) in lockstep. #39 adds the real names to
 * the allowlist so a list screen can speak either vocabulary without breaking
 * the legacy mirror/sync shape.
 */
const listItemTitle = (data: Record<string, unknown>): string =>
  typeof data.title === "string"
    ? data.title
    : typeof data.name === "string"
    ? data.name
    : ""

const listItemChecked = (data: Record<string, unknown>): boolean =>
  typeof data.checked === "boolean" ? data.checked : data.done === true

const listItemOrder = (data: Record<string, unknown>): number =>
  typeof data.sortOrder === "number" && Number.isInteger(data.sortOrder)
    ? data.sortOrder
    : encodeInt(data.ordering)

const normalizeListItem = (data: Record<string, unknown>): Record<string, unknown> => {
  const title = listItemTitle(data)
  const checked = listItemChecked(data)
  const order = listItemOrder(data)
  return {
    ...data,
    title,
    name: title,
    checked,
    done: checked,
    sortOrder: order,
    ordering: order
  }
}

/**
 * Translate the #39 aliases into the canonical wire fields **before** the merge
 * runs, so done-wins still sees `checked: true` even when a client wrote
 * `done: true`.
 */
const normalizeListItemPatch = (patch: Record<string, unknown>): Record<string, unknown> => {
  const next = { ...patch }
  if (next.title === undefined && typeof next.name === "string") next.title = next.name
  if (next.checked === undefined && typeof next.done === "boolean") next.checked = next.done
  if (next.sortOrder === undefined && typeof next.ordering === "number") {
    next.sortOrder = next.ordering
  }
  return next
}

/**
 * The scaffold columns are authoritative for the wire shape: every writer
 * (scaffold repo, real repo, sync) keeps `title`/`checked`/`sort_order` current.
 * The real ListItem columns are carried alongside so the dual-write preserves
 * them (`listId`, `checkedAt`, `color`, `tagIds`).
 */
const listItemNormalize = (row: SyncRawRow): Record<string, unknown> =>
  normalizeListItem({
    id: String(row.id),
    type: "listItem",
    title: encodeText(row.title),
    checked: asBit(row.checked),
    sortOrder: encodeInt(row.sortOrder),
    listId: asText(row.listId),
    checkedAt: asText(row.checkedAt),
    color: asText(row.color),
    tagIds: asStringArray(row.tagIds),
    lastWriterId: asText(row.lastWriterId),
    ownerId: encodeText(row.ownerId),
    visibility: asVisibility(row.visibility),
    createdAt: encodeText(row.createdAt)
  })

const LIST_ITEM_COMPLETION = { field: "checked", value: true } as const

const listItemDefinition = (sql: SqlClient.SqlClient): SyncEntityDefinition => {
  // `validate` is identity: the scaffold wire shape predates the #33 model and
  // its rows may not have a `list_id` (see the compatibility note above).
  const validateIdentity = (
    data: Record<string, unknown>
  ): Record<string, unknown> => data
  return {
    entityType: "listItem",
    table: "list_items",
    select: LIST_ITEM_COLUMNS,
    scope: SYNC_SCOPE_COLUMNS,
    softDeleteColumn: "deleted_at",
    writable: new Map([
      ["title", isString],
      ["checked", isBoolean],
      ["sortOrder", isInt],
      // #39 real-aggregate aliases; both vocabularies are accepted.
      ["name", isString],
      ["done", isBoolean],
      ["ordering", isInt],
      ["listId", isNullableString],
      ["color", isNullableString],
      ["tagIds", isStringArray],
      ["visibility", isOneOf("private", "shared")]
    ]),
    // Checklist done-wins: "I ticked it" beats "I renamed it" (§6.3).
    completion: LIST_ITEM_COMPLETION,
    defaults: (patch, context) => {
      const raw = normalizeListItemPatch(patch)
      const title = listItemTitle(raw)
      const checked = listItemChecked(raw)
      const order = listItemOrder(raw)
      return normalizeListItem({
        id: context.entityId,
        type: "listItem",
        title,
        checked,
        sortOrder: order,
        listId: asText(raw.listId),
        checkedAt: checked ? context.now : null,
        color: asText(raw.color),
        tagIds: Array.isArray(raw.tagIds) ? raw.tagIds : [],
        lastWriterId: context.userId,
        ownerId: context.userId,
        visibility: asVisibility(raw.visibility),
        createdAt: asText(raw.createdAt) ?? context.clientUpdatedAt
      })
    },
    hydrate: (row) => listItemNormalize(row),
    validate: validateIdentity,
    merge: (input) => {
      const current = normalizeListItem(input.current)
      const patch = normalizeListItemPatch(input.patch)
      const next = mergeFields(
        { completion: LIST_ITEM_COMPLETION },
        { ...input, current, patch }
      )
      // Mirror the checked flag onto the real completion audit column. On a
      // ticked-wins conflict the original `checkedAt` is preserved.
      next.checkedAt = next.checked === true
        ? (current.checked === true ? current.checkedAt ?? null : input.now)
        : null
      return normalizeListItem(next)
    },
    // Dual-write: scaffold columns (wire) + real ListItem columns (#33/#39).
    insert: (state) => sql`
      INSERT INTO list_items
        (id, title, checked, sort_order, version, created_at, updated_at, deleted_at,
         owner_id, visibility, household_id,
         type, list_id, name, done, ordering, checked_at, color, tag_ids, last_writer_id)
      VALUES
        (${state.entityId}, ${encodeText(state.data.title)},
         ${encodeBit(state.data.checked)}, ${encodeInt(state.data.sortOrder)},
         ${state.version}, ${encodeNullableText(state.data.createdAt) ?? state.updatedAt},
         ${state.updatedAt}, ${state.deletedAt}, ${state.ownerId}, ${state.visibility},
         ${state.householdId}, ${state.entityType},
         ${encodeNullableText(state.data.listId)}, ${encodeText(state.data.title)},
         ${encodeBit(state.data.checked)}, ${encodeInt(state.data.sortOrder)},
         ${encodeNullableText(state.data.checkedAt)},
         ${encodeNullableText(state.data.color)}, ${encodeJson(state.data.tagIds)},
         ${encodeNullableText(state.data.lastWriterId)})
      ON CONFLICT DO NOTHING
    `,
    update: (state, expectedVersion) => sql`
      UPDATE list_items SET
        title = ${encodeText(state.data.title)},
        checked = ${encodeBit(state.data.checked)},
        sort_order = ${encodeInt(state.data.sortOrder)},
        visibility = ${state.visibility},
        version = ${state.version},
        updated_at = ${state.updatedAt},
        deleted_at = ${state.deletedAt},
        list_id = ${encodeNullableText(state.data.listId)},
        name = ${encodeText(state.data.title)},
        done = ${encodeBit(state.data.checked)},
        ordering = ${encodeInt(state.data.sortOrder)},
        checked_at = ${encodeNullableText(state.data.checkedAt)},
        color = ${encodeNullableText(state.data.color)},
        tag_ids = ${encodeJson(state.data.tagIds)},
        last_writer_id = ${encodeNullableText(state.data.lastWriterId)}
      WHERE id = ${state.entityId} AND version = ${expectedVersion}
    `
  }
}

// ── Note ──────────────────────────────────────────────────────────────────

const NOTE_COLUMNS =
  `${META_COLUMNS}, type, title, body, plain_text AS plainText, color, ` +
  `is_pinned AS isPinned, is_archived AS isArchived, tag_ids AS tagIds, ` +
  `created_at AS createdAt`

const noteCodec = withSchema<Note>(Note, (row) => ({
  id: String(row.id),
  type: "note",
  title: encodeText(row.title),
  body: parseJson(row.body),
  plainText: encodeText(row.plainText),
  ownerId: encodeText(row.ownerId),
  householdId: encodeText(row.householdId),
  visibility: asVisibility(row.visibility),
  color: asText(row.color),
  isPinned: asBit(row.isPinned),
  isArchived: asBit(row.isArchived),
  tagIds: asStringArray(row.tagIds),
  createdAt: encodeText(row.createdAt)
}))

const noteDefinition = (sql: SqlClient.SqlClient): SyncEntityDefinition => ({
  entityType: "note",
  table: "notes",
  select: NOTE_COLUMNS,
  scope: SYNC_SCOPE_COLUMNS,
  softDeleteColumn: "deleted_at",
  writable: new Map([
    ["title", isString],
    ["body", isJson],
    ["plainText", isString],
    ["color", isNullableString],
    ["isPinned", isBoolean],
    ["isArchived", isBoolean],
    ["tagIds", isStringArray],
    ["visibility", isOneOf("private", "shared")]
  ]),
  ...noteCodec,
  defaults: (patch, context) => ({
    id: context.entityId,
    type: "note",
    title: encodeText(patch.title),
    body: patch.body === undefined ? null : patch.body,
    plainText: encodeText(patch.plainText),
    ownerId: context.userId,
    householdId: context.householdId,
    visibility: asVisibility(patch.visibility),
    color: asText(patch.color),
    isPinned: patch.isPinned === true,
    isArchived: patch.isArchived === true,
    tagIds: Array.isArray(patch.tagIds) ? patch.tagIds : [],
    createdAt: asText(patch.createdAt) ?? context.clientUpdatedAt
  }),
  merge: (input) => mergeFields({}, input),
  insert: (state) => sql`
    INSERT INTO notes
      (id, type, title, body, plain_text, owner_id, household_id, visibility,
       color, is_pinned, is_archived, tag_ids, created_at, updated_at, version, deleted_at)
    VALUES
      (${state.entityId}, ${state.entityType}, ${encodeText(state.data.title)},
       ${encodeJsonOrNull(state.data.body)},
       ${encodeText(state.data.plainText)}, ${state.ownerId}, ${state.householdId},
       ${state.visibility}, ${encodeNullableText(state.data.color)},
       ${encodeBit(state.data.isPinned)}, ${encodeBit(state.data.isArchived)},
       ${encodeJson(state.data.tagIds)},
       ${encodeNullableText(state.data.createdAt) ?? state.updatedAt},
       ${state.updatedAt}, ${state.version}, ${state.deletedAt})
    ON CONFLICT DO NOTHING
  `,
  update: (state, expectedVersion) => sql`
    UPDATE notes SET
      title = ${encodeText(state.data.title)},
      body = ${encodeJsonOrNull(state.data.body)},
      plain_text = ${encodeText(state.data.plainText)},
      visibility = ${state.visibility},
      color = ${encodeNullableText(state.data.color)},
      is_pinned = ${encodeBit(state.data.isPinned)},
      is_archived = ${encodeBit(state.data.isArchived)},
      tag_ids = ${encodeJson(state.data.tagIds)},
      updated_at = ${state.updatedAt},
      version = ${state.version},
      deleted_at = ${state.deletedAt}
    WHERE id = ${state.entityId} AND version = ${expectedVersion}
  `,
  /**
   * The note search index (#41).
   *
   * The index holds the **folded** title and body (`normalizePersian`), so a
   * note written in one Persian spelling is found by the other. Both
   * statements are gated on the note row having reached this write's
   * version/timestamp: a lost compare-and-set therefore leaves the index
   * describing the row that is actually stored.
   *
   * The first statement drops the note's previous index row, the second
   * writes the new one — both inside the same batch as the row write, so the
   * index never lags behind a committed note.
   */
  index: (state) => {
    const noteId = state.entityId
    const title = normalizePersian(encodeText(state.data.title))
    const body = normalizePersian(encodeText(state.data.plainText))
    const landed = sql`
      EXISTS (
        SELECT 1 FROM notes
        WHERE id = ${noteId} AND version = ${state.version} AND updated_at = ${state.updatedAt}
      )
    `
    return [
      sql`DELETE FROM notes_fts WHERE note_id = ${noteId} AND ${landed}`,
      sql`
        INSERT INTO notes_fts (note_id, search_title, search_body)
        SELECT ${noteId}, ${title}, ${body} WHERE ${landed}
      `
    ]
  }
})

// ── Event ─────────────────────────────────────────────────────────────────

const EVENT_COLUMNS =
  `${META_COLUMNS}, type, title, description, location, category, people, color, ` +
  `start_at AS startAt, end_at AS endAt, all_day_date AS allDayDate, ` +
  `time_zone AS timeZone, recurrence, exceptions, occasion_id AS occasionId, ` +
  `created_at AS createdAt`

/**
 * The row's timing union.
 *
 * An all-day row carries a local date; a timed row carries two instants. The
 * union is the event's *one* time shape, so a row can never hold both.
 */
const eventTimingOfRow = (row: SyncRawRow): Record<string, unknown> => {
  const allDayDate = asText(row.allDayDate)
  if (allDayDate !== null) return { _tag: "allDay", date: allDayDate }
  const createdAt = encodeText(row.createdAt)
  const start = asText(row.startAt) ?? createdAt
  return { _tag: "timed", start, end: asText(row.endAt) ?? start }
}

/**
 * The timing of a client-authored patch.
 *
 * A patch that carries a well-formed timing keeps it; anything else falls
 * back to an all-day event on the client's own date. The fallback matters for
 * a **delete-only** push: the tombstone row is inserted without validation,
 * so it still has to be a structurally valid event.
 */
const eventTimingOfPatch = (
  value: unknown,
  fallbackDate: string
): Record<string, unknown> => {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    if (
      record._tag === "timed" &&
      typeof record.start === "string" &&
      typeof record.end === "string"
    ) {
      return { _tag: "timed", start: record.start, end: record.end }
    }
    if (record._tag === "allDay" && typeof record.date === "string") {
      return { _tag: "allDay", date: record.date }
    }
  }
  return { _tag: "allDay", date: fallbackDate.slice(0, 10) }
}

const eventCodec = withSchema<Event>(Event, (row) => ({
  id: String(row.id),
  type: "event",
  title: encodeText(row.title),
  description: asText(row.description),
  location: asText(row.location),
  category: asText(row.category),
  people: asStringArray(row.people),
  timing: eventTimingOfRow(row),
  timeZone: encodeText(row.timeZone),
  recurrence: parseJson(row.recurrence),
  exceptions: parseJson(row.exceptions),
  occasionId: asText(row.occasionId),
  ownerId: encodeText(row.ownerId),
  householdId: encodeText(row.householdId),
  visibility: asVisibility(row.visibility),
  color: asText(row.color),
  createdAt: encodeText(row.createdAt)
}))

const EVENT_WRITABLE: ReadonlyMap<string, SyncFieldGuard> = new Map([
  ["title", isString],
  ["description", isNullableString],
  ["location", isNullableString],
  ["category", isNullableString],
  ["color", isNullableString],
  ["people", isStringArray],
  // The timing is one unit: a patch replaces the whole union, so a row can
  // never end up with an instant *and* an all-day date. The shape itself is
  // validated by the Event schema below.
  ["timing", isJson],
  ["timeZone", isString],
  // The rule object is validated structurally by the Event schema below; the
  // guard only rejects non-JSON scalars.
  ["recurrence", isJson],
  ["exceptions", isJsonArray],
  ["occasionId", isNullableString],
  ["visibility", isOneOf("private", "shared")]
])

/**
 * The event's timing columns.
 *
 * The union is one field on the wire, so it maps to either the two instants
 * or the local date — never to both.
 */
const eventTimingColumns = (
  data: Record<string, unknown>
): {
  readonly startAt: string | null
  readonly endAt: string | null
  readonly allDayDate: string | null
} => {
  const timing = data.timing
  if (typeof timing === "object" && timing !== null) {
    const record = timing as Record<string, unknown>
    if (record._tag === "allDay") {
      return {
        startAt: null,
        endAt: null,
        allDayDate: typeof record.date === "string" ? record.date : null
      }
    }
    return {
      startAt: typeof record.start === "string" ? record.start : null,
      endAt: typeof record.end === "string" ? record.end : null,
      allDayDate: null
    }
  }
  return { startAt: null, endAt: null, allDayDate: null }
}

const eventDefinition = (sql: SqlClient.SqlClient): SyncEntityDefinition => ({
  entityType: "event",
  table: "events",
  select: EVENT_COLUMNS,
  scope: SYNC_SCOPE_COLUMNS,
  softDeleteColumn: "deleted_at",
  writable: EVENT_WRITABLE,
  ...eventCodec,
  defaults: (patch, context) => ({
    id: context.entityId,
    type: "event",
    title: encodeText(patch.title),
    description: asText(patch.description),
    location: asText(patch.location),
    category: asText(patch.category),
    color: asText(patch.color),
    people: asStringArray(patch.people),
    timing: eventTimingOfPatch(patch.timing, context.clientUpdatedAt),
    timeZone: encodeText(patch.timeZone) || "UTC",
    recurrence: patch.recurrence ?? null,
    exceptions: Array.isArray(patch.exceptions) ? patch.exceptions : [],
    occasionId: asText(patch.occasionId),
    ownerId: context.userId,
    householdId: context.householdId,
    visibility: asVisibility(patch.visibility),
    createdAt: asText(patch.createdAt) ?? context.clientUpdatedAt
  }),
  /**
   * The shared field-level LWW merge — the same one every other aggregate
   * uses (`docs/sync-protocol-draft.md` §6).
   *
   * The timing is one unit: a patch that carries a timing replaces the whole
   * union (the merge applies the patch field by field, and `timing` is one
   * field), and a `null` rule clears the rule and nothing else.
   *
   * It has to stay the *shared* merge: a field the patch lost the conflict
   * over — the client edit is older than the stored one — keeps the stored
   * value. An event-specific merge that re-applied the patch's timing or rule
   * would let a stale offline device move an event to another day, which is
   * exactly the data loss the LWW rule exists to prevent.
   */
  merge: (input) => mergeFields({}, input),
  insert: (state) => {
    const timing = eventTimingColumns(state.data)
    return sql`
      INSERT INTO events
        (id, type, title, description, location, category, people,
         owner_id, household_id, visibility, color, start_at, end_at,
         all_day_date, time_zone, recurrence, exceptions, occasion_id,
         created_at, updated_at, version, deleted_at)
      VALUES
        (${state.entityId}, ${state.entityType}, ${encodeText(state.data.title)},
         ${encodeNullableText(state.data.description)},
         ${encodeNullableText(state.data.location)},
         ${encodeNullableText(state.data.category)},
         ${encodeJson(state.data.people)},
         ${state.ownerId}, ${state.householdId}, ${state.visibility},
         ${encodeNullableText(state.data.color)},
         ${timing.startAt}, ${timing.endAt}, ${timing.allDayDate},
         ${encodeText(state.data.timeZone)},
         ${encodeJsonOrNull(state.data.recurrence)},
         ${encodeJson(state.data.exceptions)},
         ${encodeNullableText(state.data.occasionId)},
         ${encodeNullableText(state.data.createdAt) ?? state.updatedAt},
         ${state.updatedAt}, ${state.version}, ${state.deletedAt})
      ON CONFLICT DO NOTHING
    `
  },
  update: (state, expectedVersion) => {
    const timing = eventTimingColumns(state.data)
    return sql`
      UPDATE events SET
        title = ${encodeText(state.data.title)},
        description = ${encodeNullableText(state.data.description)},
        location = ${encodeNullableText(state.data.location)},
        category = ${encodeNullableText(state.data.category)},
        people = ${encodeJson(state.data.people)},
        visibility = ${state.visibility},
        color = ${encodeNullableText(state.data.color)},
        start_at = ${timing.startAt},
        end_at = ${timing.endAt},
        all_day_date = ${timing.allDayDate},
        time_zone = ${encodeText(state.data.timeZone)},
        recurrence = ${encodeJsonOrNull(state.data.recurrence)},
        exceptions = ${encodeJson(state.data.exceptions)},
        occasion_id = ${encodeNullableText(state.data.occasionId)},
        updated_at = ${state.updatedAt},
        version = ${state.version},
        deleted_at = ${state.deletedAt}
      WHERE id = ${state.entityId} AND version = ${expectedVersion}
    `
  }
})

// ── Habit + HabitEntry (ticket #63; FR-HAB-01/02) ─────────────────────────

const HABIT_COLUMNS =
  `${META_COLUMNS}, type, title, description, icon, color, started_on AS startedOn, ` +
  `frequency, frequency_history AS frequencyHistory, reminder_time AS reminderTime, ` +
  `time_zone AS timeZone, created_at AS createdAt`

const habitCodec = withSchema<Habit>(Habit, (row) => {
  const history = parseJson(row.frequencyHistory)
  return {
    id: String(row.id),
    type: "habit",
    title: encodeText(row.title),
    description: asText(row.description),
    icon: asText(row.icon),
    ownerId: encodeText(row.ownerId),
    householdId: encodeText(row.householdId),
    visibility: asVisibility(row.visibility),
    color: asText(row.color),
    startedOn: encodeText(row.startedOn),
    frequency: parseJson(row.frequency) ?? { _tag: "daily" },
    frequencyHistory: Array.isArray(history) ? history : [],
    reminderTime: asText(row.reminderTime),
    timeZone: encodeText(row.timeZone) || "UTC",
    createdAt: encodeText(row.createdAt)
  }
})

const HABIT_WRITABLE: ReadonlyMap<string, SyncFieldGuard> = new Map([
  ["title", isString],
  ["description", isNullableString],
  ["color", isNullableString],
  ["icon", isNullableString],
  // The union is one unit: a patch replaces the whole frequency, and the shape
  // is validated by the Habit schema below. `frequencyHistory` is deliberately
  // absent — it is server-managed, so a client patch can never rewrite the
  // history the stats are computed from.
  ["frequency", isJson],
  ["reminderTime", isNullableString],
  ["timeZone", isString],
  ["visibility", isOneOf("private", "shared")]
])

/** The habit's frequency as the union the model expects; `daily` only when absent. */
const habitFrequencyOfPatch = (value: unknown): Record<string, unknown> =>
  value === undefined || value === null
    ? { _tag: "daily" }
    : (value as Record<string, unknown>)

const habitDefinition = (sql: SqlClient.SqlClient): SyncEntityDefinition => ({
  entityType: "habit",
  table: "habits",
  select: HABIT_COLUMNS,
  scope: SYNC_SCOPE_COLUMNS,
  softDeleteColumn: "deleted_at",
  writable: HABIT_WRITABLE,
  ...habitCodec,
  defaults: (patch, context) => {
    const timeZone = encodeText(patch.timeZone) || "UTC"
    const frequency = habitFrequencyOfPatch(patch.frequency) as unknown as HabitFrequency
    // The habit began on the owner's local creation day. The client's creation
    // instant is the edit time (a validated ISO string); a malformed custom
    // `createdAt` falls back to it, then to the commit instant, so a bad value
    // can never throw inside the batch planner.
    const createdAt = asText(patch.createdAt)
    const startedOn = (createdAt !== null
      ? localDateInOption(createdAt, timeZone)
      : null) ??
      localDateInOption(context.clientUpdatedAt, timeZone) ??
      localDateIn(context.now, "UTC")
    return {
      id: context.entityId,
      type: "habit",
      title: encodeText(patch.title),
      description: asText(patch.description),
      icon: asText(patch.icon),
      ownerId: context.userId,
      householdId: context.householdId,
      visibility: asVisibility(patch.visibility),
      color: asText(patch.color),
      startedOn,
      frequency,
      // An offline create seeds era 0 exactly like the service does: the
      // habit's own zone, on the day it began.
      frequencyHistory: [{ effectiveFrom: startedOn, frequency }],
      reminderTime: asText(patch.reminderTime),
      timeZone,
      createdAt: asText(patch.createdAt) ?? context.clientUpdatedAt
    }
  },
  /**
   * Shared field LWW, plus the frequency era log.
   *
   * The log is only grown when the merge actually adopted a *different*
   * frequency: a patch that lost the conflict (or repeated the current
   * frequency) leaves it untouched, so an offline edit can never append an era
   * that never applied. The boundary is computed from the **server's** commit
   * instant in the habit's zone — never from `clientUpdatedAt` — so a change
   * can never be back-dated behind the era it replaces (#65).
   */
  merge: (input) => {
    const next = mergeFields({}, input)
    const currentFrequency = input.current.frequency as HabitFrequency | undefined
    const nextFrequency = next.frequency as HabitFrequency | undefined
    if (nextFrequency !== undefined) {
      // Decode before comparing: the schema strips unknown keys and the
      // comparison is structural, so a differently-shaped-but-equal patch
      // (`{_tag:"daily", days:[1]}`) cannot grow a phantom era. An invalid
      // union is left as-is and rejected by `validate` below.
      const decoded = Schema.decodeUnknownOption(HabitFrequency)(nextFrequency)
      if (decoded._tag === "None") return next
      const frequency = decoded.value
      next.frequency = frequency
      if (
        currentFrequency === undefined ||
        !sameHabitFrequency(currentFrequency, frequency)
      ) {
        const history = Array.isArray(next.frequencyHistory)
          ? (next.frequencyHistory as ReadonlyArray<HabitFrequencyChange>)
          : []
        const timeZone = encodeText(next.timeZone) || "UTC"
        next.frequencyHistory = habitFrequencyHistoryAfter({
          history,
          frequency,
          changeDate: localDateInOption(input.now, timeZone) ?? localDateIn(input.now, "UTC")
        })
      }
    }
    return next
  },
  insert: (state) => sql`
    INSERT INTO habits
      (id, type, title, description, icon, owner_id, household_id, visibility,
       color, started_on, frequency, frequency_history, reminder_time, time_zone,
       created_at, updated_at, version, deleted_at)
    VALUES
      (${state.entityId}, ${state.entityType}, ${encodeText(state.data.title)},
       ${encodeNullableText(state.data.description)},
       ${encodeNullableText(state.data.icon)}, ${state.ownerId},
       ${state.householdId}, ${state.visibility},
       ${encodeNullableText(state.data.color)},
       ${encodeText(state.data.startedOn)},
       ${encodeJson(state.data.frequency)},
       ${encodeJson(state.data.frequencyHistory)},
       ${encodeNullableText(state.data.reminderTime)},
       ${encodeText(state.data.timeZone) || "UTC"},
       ${encodeNullableText(state.data.createdAt) ?? state.updatedAt},
       ${state.updatedAt}, ${state.version}, ${state.deletedAt})
    ON CONFLICT DO NOTHING
  `,
  update: (state, expectedVersion) => sql`
    UPDATE habits SET
      title = ${encodeText(state.data.title)},
      description = ${encodeNullableText(state.data.description)},
      icon = ${encodeNullableText(state.data.icon)},
      visibility = ${state.visibility},
      color = ${encodeNullableText(state.data.color)},
      frequency = ${encodeJson(state.data.frequency)},
      frequency_history = ${encodeJson(state.data.frequencyHistory)},
      reminder_time = ${encodeNullableText(state.data.reminderTime)},
      time_zone = ${encodeText(state.data.timeZone) || "UTC"},
      updated_at = ${state.updatedAt},
      version = ${state.version},
      deleted_at = ${state.deletedAt}
    WHERE id = ${state.entityId} AND version = ${expectedVersion}
  `
})

const HABIT_ENTRY_COLUMNS =
  `${META_COLUMNS}, habit_id AS habitId, local_date AS localDate, ` +
  `time_zone AS timeZone, status, created_at AS createdAt`

const habitEntryCodec = withSchema<HabitEntry>(HabitEntry, (row) => ({
  id: String(row.id),
  habitId: encodeText(row.habitId),
  ownerId: encodeText(row.ownerId),
  householdId: encodeText(row.householdId),
  visibility: asVisibility(row.visibility),
  localDate: encodeText(row.localDate),
  timeZone: encodeText(row.timeZone) || "UTC",
  status: encodeText(row.status) || "done",
  createdAt: encodeText(row.createdAt)
}))

const HABIT_ENTRY_WRITABLE: ReadonlyMap<string, SyncFieldGuard> = new Map([
  // The entry's identity on the wire: a tap names the habit and the local day
  // it logs. Both are validated by the HabitEntry schema below.
  ["habitId", isString],
  ["localDate", isLocalDate],
  ["timeZone", isString],
  ["status", isOneOf("done", "partial", "missed")],
  ["visibility", isOneOf("private", "shared")]
])

const habitEntryDefinition = (sql: SqlClient.SqlClient): SyncEntityDefinition => ({
  entityType: "habitEntry",
  table: "habit_entries",
  select: HABIT_ENTRY_COLUMNS,
  scope: SYNC_SCOPE_COLUMNS,
  softDeleteColumn: "deleted_at",
  writable: HABIT_ENTRY_WRITABLE,
  parent: { entityType: "habit", field: "habitId", inheritVisibility: true },
  strict: ["habitId", "localDate", "status"],
  ...habitEntryCodec,
  defaults: (patch, context) => {
    const timeZone = encodeText(patch.timeZone) || "UTC"
    return {
      id: context.entityId,
      habitId: encodeText(patch.habitId) || null,
      ownerId: context.userId,
      householdId: context.householdId,
      visibility: asVisibility(patch.visibility),
      // The day the tap logged: the client sends it, so a backdated or
      // timezone-crossing tap is explicit. A delete-only push carries none, so
      // fall back to the local date of the write instant (never a throw: a bad
      // zone is rejected by the model below).
      localDate: encodeText(patch.localDate) ||
        (localDateInOption(context.clientUpdatedAt, timeZone) ??
          localDateIn(context.now, "UTC")),
      timeZone,
      // No default: an entry always has a status, so a value the client sent
      // outside the enum must be rejected as an invalid patch, not silently
      // recorded as `done` (the RPC path rejects it too).
      status: encodeText(patch.status),
      createdAt: asText(patch.createdAt) ?? context.clientUpdatedAt
    }
  },
  /**
   * Plain field LWW. A logged day has no "completion wins" rule of its own:
   * the later status the user chose is the one that stands, and `deletedAt`
   * keeps the shared tombstone-wins rule from `mergeFields`.
   */
  merge: (input) => mergeFields({}, input),
  insert: (state) => sql`
    INSERT INTO habit_entries
      (id, habit_id, owner_id, household_id, visibility, local_date,
       time_zone, status, created_at, updated_at, version, deleted_at)
    VALUES
      (${state.entityId}, ${encodeText(state.data.habitId)}, ${state.ownerId},
       ${state.householdId}, ${state.visibility},
       ${encodeText(state.data.localDate)},
       ${encodeText(state.data.timeZone) || "UTC"},
       ${encodeText(state.data.status)},
       ${encodeNullableText(state.data.createdAt) ?? state.updatedAt},
       ${state.updatedAt}, ${state.version}, ${state.deletedAt})
    ON CONFLICT DO NOTHING
  `,
  update: (state, expectedVersion) => sql`
    UPDATE habit_entries SET
      visibility = ${state.visibility},
      time_zone = ${encodeText(state.data.timeZone) || "UTC"},
      status = ${encodeText(state.data.status)},
      updated_at = ${state.updatedAt},
      version = ${state.version},
      deleted_at = ${state.deletedAt}
    WHERE id = ${state.entityId} AND version = ${expectedVersion}
  `
  }
})

// ── Reminder ──────────────────────────────────────────────────────────────

const REMINDER_COLUMNS =
  `${META_COLUMNS}, type, title, note, color, kind, tier, repeat, ` +
  `offset_minutes AS offsetMinutes, fire_at AS fireAt, ` +
  `link_type AS linkType, link_id AS linkId, silenced_until AS silencedUntil, ` +
  `time_zone AS timeZone, created_at AS createdAt`

/** Rebuild the link union from the flattened columns (malformed → none). */
const reminderLinkOf = (type: unknown, id: unknown): Record<string, unknown> => {
  const linkId = asText(id)
  switch (type) {
    case "task":
      return linkId === null ? { _tag: "none" } : { _tag: "task", taskId: linkId }
    case "event":
      return linkId === null ? { _tag: "none" } : { _tag: "event", eventId: linkId }
    case "habit":
      return linkId === null ? { _tag: "none" } : { _tag: "habit", habitId: linkId }
    default:
      return { _tag: "none" }
  }
}

/** Flatten the link union for the two columns (the only writer is trusted). */
const reminderLinkColumns = (
  data: Record<string, unknown>
): { readonly linkType: string; readonly linkId: string | null } => {
  const link = data.link
  if (typeof link === "object" && link !== null) {
    const record = link as Record<string, unknown>
    switch (record._tag) {
      case "task":
        return { linkType: "task", linkId: asText(record.taskId) }
      case "event":
        return { linkType: "event", linkId: asText(record.eventId) }
      case "habit":
        return { linkType: "habit", linkId: asText(record.habitId) }
      default:
        return { linkType: "none", linkId: null }
    }
  }
  return { linkType: "none", linkId: null }
}

const reminderRepeatOf = (value: unknown): Record<string, unknown> => {
  const parsed = parseJson(value)
  if (typeof parsed === "object" && parsed !== null) {
    return parsed as Record<string, unknown>
  }
  // A delete-only tombstone may be inserted without a valid repeat; the model
  // still has to be structurally valid, so fall back to a one-off.
  return { _tag: "once" }
}

/**
 * The sweep compares `fire_at` as TEXT, so a synced instant has to be
 * canonical UTC — the same normalisation the service applies on its write path.
 */
const normalizeInstantText = (value: unknown): unknown => {
  if (typeof value !== "string") return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

const reminderCodec = withSchema<Reminder>(Reminder, (row) => ({
  id: String(row.id),
  type: "reminder",
  title: encodeText(row.title),
  note: asText(row.note),
  kind: encodeText(row.kind) || "general",
  tier: encodeText(row.tier) || "normal",
  repeat: reminderRepeatOf(row.repeat),
  fireAt: encodeText(row.fireAt),
  offsetMinutes: encodeInt(row.offsetMinutes),
  link: reminderLinkOf(row.linkType, row.linkId),
  silencedUntil: asText(row.silencedUntil),
  timeZone: encodeText(row.timeZone) || "UTC",
  ownerId: encodeText(row.ownerId),
  householdId: encodeText(row.householdId),
  visibility: asVisibility(row.visibility),
  color: asText(row.color),
  createdAt: encodeText(row.createdAt)
}))

const REMINDER_WRITABLE: ReadonlyMap<string, SyncFieldGuard> = new Map([
  ["title", isString],
  ["note", isNullableString],
  ["color", isNullableString],
  // The tier is derived from the kind at write time and is deliberately not
  // writable: a client can never make a non-medication reminder critical.
  ["kind", isOneOf("medication", "exercise", "chore", "general")],
  // The repeat union is replaced as one unit; the shape is validated by the
  // Reminder schema below.
  ["repeat", isJson],
  ["fireAt", isString],
  ["offsetMinutes", isInt],
  ["link", isJson],
  ["silencedUntil", isNullableString],
  ["timeZone", isString],
  ["visibility", isOneOf("private", "shared")]
])

const reminderDefinition = (sql: SqlClient.SqlClient): SyncEntityDefinition => ({
  entityType: "reminder",
  table: "reminders",
  select: REMINDER_COLUMNS,
  scope: SYNC_SCOPE_COLUMNS,
  softDeleteColumn: "deleted_at",
  writable: REMINDER_WRITABLE,
  ...reminderCodec,
  defaults: (patch, context) => {
    const kind = encodeText(patch.kind) || "general"
    const repeat = reminderRepeatOf(patch.repeat)
    const timeZone = encodeText(patch.timeZone) || "UTC"
    const explicitFireAt = asText(patch.fireAt)
    // The service derives a pattern reminder's first fire from its repeat; the
    // offline-create path must do the same, or a daily/weekly reminder synced
    // without a fireAt would fire at the edit instant instead of its local
    // time. A one-off with neither an explicit fireAt nor a (sync-resolved)
    // link keeps the edit instant as its best available anchor.
    const fireAt = normalizeInstantText(
      explicitFireAt ??
        reminderFireAt({
          repeat: repeat as Reminder["repeat"],
          timeZone,
          now: context.clientUpdatedAt,
          explicitFireAt: null,
          linkInstant: null
        }) ??
        context.clientUpdatedAt
    )
    return {
      id: context.entityId,
      type: "reminder",
      title: encodeText(patch.title),
      note: asText(patch.note),
      color: asText(patch.color),
      kind,
      tier: reminderTierFor(kind as ReminderType),
      repeat,
      fireAt,
      offsetMinutes: encodeInt(patch.offsetMinutes),
      link: reminderLinkOf(
        (patch.link as Record<string, unknown> | undefined)?._tag,
        (patch.link as Record<string, unknown> | undefined)?.taskId ??
          (patch.link as Record<string, unknown> | undefined)?.eventId ??
          (patch.link as Record<string, unknown> | undefined)?.habitId
      ),
      silencedUntil: normalizeInstantText(asText(patch.silencedUntil)),
      timeZone,
      ownerId: context.userId,
      householdId: context.householdId,
      visibility: asVisibility(patch.visibility),
      createdAt: asText(patch.createdAt) ?? context.clientUpdatedAt
    }
  },
  merge: (input) => {
    const next = mergeFields({}, input)
    // Type drives tier: re-derive after every merge so a kind change cannot
    // leave a stale critical/normal flag (and a patch cannot forge one).
    next.tier = reminderTierFor(next.kind as ReminderType)
    // Keep the scheduling columns canonical so the sweep's TEXT comparison is
    // an instant ordering, whichever device wrote the patch.
    next.fireAt = normalizeInstantText(next.fireAt)
    next.silencedUntil = next.silencedUntil === null
      ? null
      : normalizeInstantText(next.silencedUntil)
    return next
  },
  /**
   * Silence and delete must also expire any dispatch already owed, so a held
   * row cannot push after the owner changed their mind (ADR-0005 §5). The
   * statement is gated on this write actually landing, so a lost CAS leaves
   * the ledger untouched.
   */
  index: (state) => {
    const silenced = typeof state.data.silencedUntil === "string"
    if (state.deletedAt === null && !silenced) return []
    return [
      sql`
        UPDATE reminder_dispatches SET push_outcome = 'expired'
        WHERE reminder_id = ${state.entityId}
          AND response IS NULL
          AND push_outcome IN ('pending', 'failed')
          AND EXISTS (
            SELECT 1 FROM reminders
            WHERE id = ${state.entityId}
              AND version = ${state.version}
              AND updated_at = ${state.updatedAt}
          )
      `
    ]
  },
  insert: (state) => {
    const link = reminderLinkColumns(state.data)
    return sql`
      INSERT INTO reminders
        (id, type, title, note, owner_id, household_id, visibility, color,
         kind, tier, repeat, offset_minutes, fire_at, link_type, link_id,
         silenced_until, time_zone, created_at, updated_at, version, deleted_at)
      VALUES
        (${state.entityId}, ${state.entityType}, ${encodeText(state.data.title)},
         ${encodeNullableText(state.data.note)}, ${state.ownerId},
         ${state.householdId}, ${state.visibility},
         ${encodeNullableText(state.data.color)}, ${encodeText(state.data.kind)},
         ${encodeText(state.data.tier) || reminderTierFor(state.data.kind as ReminderType)},
         ${encodeJson(state.data.repeat)}, ${encodeInt(state.data.offsetMinutes)},
         ${encodeText(state.data.fireAt)}, ${link.linkType}, ${link.linkId},
         ${encodeNullableText(state.data.silencedUntil)},
         ${encodeText(state.data.timeZone) || "UTC"},
         ${encodeNullableText(state.data.createdAt) ?? state.updatedAt},
         ${state.updatedAt}, ${state.version}, ${state.deletedAt})
      ON CONFLICT DO NOTHING
    `
  },
  update: (state, expectedVersion) => {
    const link = reminderLinkColumns(state.data)
    return sql`
      UPDATE reminders SET
        title = ${encodeText(state.data.title)},
        note = ${encodeNullableText(state.data.note)},
        visibility = ${state.visibility},
        color = ${encodeNullableText(state.data.color)},
        kind = ${encodeText(state.data.kind)},
        tier = ${encodeText(state.data.tier) || reminderTierFor(state.data.kind as ReminderType)},
        repeat = ${encodeJson(state.data.repeat)},
        offset_minutes = ${encodeInt(state.data.offsetMinutes)},
        fire_at = ${encodeText(state.data.fireAt)},
        link_type = ${link.linkType},
        link_id = ${link.linkId},
        silenced_until = ${encodeNullableText(state.data.silencedUntil)},
        time_zone = ${encodeText(state.data.timeZone) || "UTC"},
        updated_at = ${state.updatedAt},
        version = ${state.version},
        deleted_at = ${state.deletedAt}
      WHERE id = ${state.entityId} AND version = ${expectedVersion}
    `
  }
})

// ── Registry ──────────────────────────────────────────────────────────────

/** Aggregates that sync today. Other `ItemType`s still reject as unsupported. */
export const SYNC_ENTITY_TYPES = [
  "task",
  "project",
  "tag",
  "list",
  "listItem",
  "note",
  "event",
  "habit",
  "habitEntry"
,
  "reminder"
] as const satisfies ReadonlyArray<SyncEntityType>

export const makeSyncRegistry = (sql: SqlClient.SqlClient): SyncRegistry => {
  const definitions = [
    taskDefinition(sql),
    projectDefinition(sql),
    tagDefinition(sql),
    listDefinition(sql),
    listItemDefinition(sql),
    noteDefinition(sql),
    eventDefinition(sql),
    habitDefinition(sql),
    habitEntryDefinition(sql)
,
    reminderDefinition(sql)
  ]
  const byType = new Map<SyncEntityType, SyncEntityDefinition>(
    definitions.map((definition) => [definition.entityType, definition])
  )
  return {
    get: (entityType) => byType.get(entityType),
    all: () => definitions
  }
}
