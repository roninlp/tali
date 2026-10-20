import { Schema } from "effect"
import { type SqlClient, Statement } from "effect/sql"
import {
  List,
  Note,
  Project,
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
 * current. This retires #33's one-way dual-write for sync-authored rows; the
 * real ListItem columns are written but not yet part of the wire payload
 * (#39's list UI can extend the allowlist with `listId`).
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
const isJson: SyncFieldGuard = (value) => {
  if (value === null || value === undefined) return true
  const kind = typeof value
  return kind === "string" || kind === "number" || kind === "boolean" || kind === "object"
}

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
  startedAt: asText(row.startedAt),
  completedAt: asText(row.completedAt),
  ownerId: encodeText(row.ownerId),
  householdId: encodeText(row.householdId),
  visibility: asVisibility(row.visibility),
  createdAt: encodeText(row.createdAt)
}))

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
  ["visibility", isOneOf("private", "shared")]
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
    startedAt: null,
    completedAt: null,
    ownerId: context.userId,
    householdId: context.householdId,
    visibility: asVisibility(patch.visibility),
    createdAt: asText(patch.createdAt) ?? context.clientUpdatedAt
  }),
  merge: (input) => {
    const next = mergeFields({ completion: TASK_COMPLETION }, input)
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
  insert: (state) => sql`
    INSERT INTO tasks
      (id, type, title, description, owner_id, household_id, visibility,
       status, priority, due_at, due_date, time_zone, project_id, tag_ids,
       color, started_at, completed_at, created_at, updated_at, version, deleted_at)
    VALUES
      (${state.entityId}, ${state.entityType}, ${encodeText(state.data.title)},
       ${encodeNullableText(state.data.description)}, ${state.ownerId},
       ${state.householdId}, ${state.visibility}, ${encodeText(state.data.status)},
       ${encodeText(state.data.priority)}, ${encodeNullableText(state.data.dueAt)},
       ${encodeNullableText(state.data.dueDate)}, ${encodeText(state.data.timeZone)},
       ${encodeNullableText(state.data.projectId)}, ${encodeJson(state.data.tagIds)},
       ${encodeNullableText(state.data.color)},
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
  `checked_placement AS checkedPlacement, created_at AS createdAt`

const listCodec = withSchema<List>(List, (row) => ({
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
    createdAt: asText(patch.createdAt) ?? context.clientUpdatedAt
  }),
  merge: (input) => mergeFields({}, input),
  insert: (state) => sql`
    INSERT INTO lists
      (id, type, title, description, owner_id, household_id, visibility,
       color, icon, sort, checked_placement, created_at, updated_at, version, deleted_at)
    VALUES
      (${state.entityId}, ${state.entityType}, ${encodeText(state.data.title)},
       ${encodeNullableText(state.data.description)}, ${state.ownerId},
       ${state.householdId}, ${state.visibility},
       ${encodeNullableText(state.data.color)}, ${encodeNullableText(state.data.icon)},
       ${encodeText(state.data.sort)}, ${encodeText(state.data.checkedPlacement)},
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
      updated_at = ${state.updatedAt},
      version = ${state.version},
      deleted_at = ${state.deletedAt}
    WHERE id = ${state.entityId} AND version = ${expectedVersion}
  `
})

// ── ListItem (legacy wire shape, dual-write) ──────────────────────────────

const LIST_ITEM_COLUMNS =
  `${META_COLUMNS}, type, title, checked, sort_order AS sortOrder, list_id AS listId, ` +
  `checked_at AS checkedAt, color, tag_ids AS tagIds, created_at AS createdAt`

/**
 * The scaffold columns are authoritative for the wire shape: every writer
 * (scaffold repo, real repo, sync) keeps `title`/`checked`/`sort_order` current.
 * The real ListItem columns are carried alongside so the dual-write preserves
 * them (`listId`, `checkedAt`, `color`, `tagIds`).
 */
const listItemNormalize = (row: SyncRawRow): Record<string, unknown> => ({
  id: String(row.id),
  type: "listItem",
  title: encodeText(row.title),
  checked: asBit(row.checked),
  sortOrder: encodeInt(row.sortOrder),
  listId: asText(row.listId),
  checkedAt: asText(row.checkedAt),
  color: asText(row.color),
  tagIds: asStringArray(row.tagIds),
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
      // Extended allowlist; the web client never sends it (#39 will).
      ["listId", isNullableString],
      ["color", isNullableString],
      ["tagIds", isStringArray],
      ["visibility", isOneOf("private", "shared")]
    ]),
    // Checklist done-wins: "I ticked it" beats "I renamed it" (§6.3).
    completion: LIST_ITEM_COMPLETION,
    defaults: (patch, context) => ({
      id: context.entityId,
      type: "listItem",
      title: encodeText(patch.title),
      checked: patch.checked === true,
      sortOrder: encodeInt(patch.sortOrder),
      listId: asText(patch.listId),
      checkedAt: patch.checked === true ? context.now : null,
      color: asText(patch.color),
      tagIds: Array.isArray(patch.tagIds) ? patch.tagIds : [],
      ownerId: context.userId,
      visibility: asVisibility(patch.visibility),
      createdAt: asText(patch.createdAt) ?? context.clientUpdatedAt
    }),
    hydrate: (row) => listItemNormalize(row),
    validate: validateIdentity,
    merge: (input) => {
      const next = mergeFields({ completion: LIST_ITEM_COMPLETION }, input)
      // Mirror the checked flag onto the real completion audit column.
      next.checkedAt = next.checked === true
        ? (input.current.checked === true ? input.current.checkedAt ?? null : input.now)
        : null
      return next
    },
    // Dual-write: scaffold columns (wire) + real ListItem columns (#33/#39).
    insert: (state) => sql`
      INSERT INTO list_items
        (id, title, checked, sort_order, version, created_at, updated_at, deleted_at,
         owner_id, visibility, household_id,
         type, list_id, name, done, ordering, checked_at, color, tag_ids)
      VALUES
        (${state.entityId}, ${encodeText(state.data.title)},
         ${encodeBit(state.data.checked)}, ${encodeInt(state.data.sortOrder)},
         ${state.version}, ${encodeNullableText(state.data.createdAt) ?? state.updatedAt},
         ${state.updatedAt}, ${state.deletedAt}, ${state.ownerId}, ${state.visibility},
         ${state.householdId}, ${state.entityType},
         ${encodeNullableText(state.data.listId)}, ${encodeText(state.data.title)},
         ${encodeBit(state.data.checked)}, ${encodeInt(state.data.sortOrder)},
         ${encodeNullableText(state.data.checkedAt)},
         ${encodeNullableText(state.data.color)}, ${encodeJson(state.data.tagIds)})
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
        tag_ids = ${encodeJson(state.data.tagIds)}
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
  `
})

// ── Registry ──────────────────────────────────────────────────────────────

/** Aggregates that sync today. Other `ItemType`s still reject as unsupported. */
export const SYNC_ENTITY_TYPES = [
  "task",
  "project",
  "tag",
  "list",
  "listItem",
  "note"
] as const satisfies ReadonlyArray<SyncEntityType>

export const makeSyncRegistry = (sql: SqlClient.SqlClient): SyncRegistry => {
  const definitions = [
    taskDefinition(sql),
    projectDefinition(sql),
    tagDefinition(sql),
    listDefinition(sql),
    listItemDefinition(sql),
    noteDefinition(sql)
  ]
  const byType = new Map<SyncEntityType, SyncEntityDefinition>(
    definitions.map((definition) => [definition.entityType, definition])
  )
  return {
    get: (entityType) => byType.get(entityType),
    all: () => definitions
  }
}
