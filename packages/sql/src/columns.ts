import { type SqlClient, Statement } from 'effect/sql'

/**
 * Declarative column descriptors for the synced aggregates' tables (#115).
 *
 * Every synced aggregate's column set used to be hand-kept in lockstep 3–4
 * times: the DDL (`migrations/`), the repo's projection + INSERT + UPDATE
 * lists, and the sync registry's projection + INSERT + UPDATE — a different
 * constant with the same name in two files (`TASK_COLUMNS` existed in both
 * `task-repo.ts` and `sync-registry.ts`), with nothing type-checking their
 * agreement except the suites that run the real migrations. Adding one column
 * to a synced aggregate touched five SQL lists across two files.
 *
 * A descriptor is the **one** place an aggregate's physical columns are
 * declared: per field, the physical name, the wire/model field it
 * round-trips, the storage codec, and the flags (immutable columns never
 * appear in an UPDATE SET; sync-managed columns are the registry's alone).
 * Small pure builders turn one descriptor plus a values record — the only
 * per-writer glue left — into the trusted SELECT list, the parameterized
 * INSERT and the UPDATE SET list, for **both** the repo and the registry
 * entry. A client can never choose a column name through them: every column
 * comes from the descriptor, every value is a bound parameter.
 *
 * ## Dual-write and union-flattening mirrors
 *
 * A field may write more than one physical column. `list_items` dual-writes
 * the scaffold (`title`/`checked`/`sort_order`) and real
 * (`name`/`done`/`ordering`) column sets from one wire field each, and the
 * event's `timing` / reminder's `link` unions flatten into three / two
 * columns. Mirrors keep those cases inside the descriptor instead of forking
 * its builders — each mirror carries its own SELECT alias and may override
 * the entry's codec.
 *
 * ## Who writes what
 *
 * A statement includes a column only when the writer supplied a value for
 * its field — the same contract a hand-written statement had. The repos have
 * no value for the sync-managed attribution columns (`last_writer_id`), so
 * their statements never mention them; the registry always does. The repos'
 * SELECT excludes sync-managed columns (their rows are returned to clients
 * as-is), while `selectList(table, { syncManaged: true })` includes them for
 * the registry's hydration.
 */

// ── Storage codecs ────────────────────────────────────────────────────────

/** How a wire value becomes a D1 binding. */
export type ColumnCodec = (value: unknown) => unknown

/**
 * The storage codecs the repos and the sync registry share.
 *
 * The repos bind already-validated model values, so the fallbacks only ever
 * fire on the registry's defensive path — but one codec per column is what
 * lets a descriptor serve both writers without drift.
 */
export const columnCodecs = {
  /** NOT NULL TEXT: a string binds as-is, anything else binds as `''`. */
  text: (value: unknown): string => (typeof value === 'string' ? value : ''),
  /** Nullable TEXT: a string binds as-is, anything else binds as `NULL`. */
  nullableText: (value: unknown): string | null =>
    typeof value === 'string' ? value : null,
  /** NOT NULL JSON column: `null` binds as the JSON text `"null"`. */
  json: (value: unknown): string => JSON.stringify(value ?? null),
  /** Nullable JSON column: absent binds `NULL`, anything else as JSON text. */
  jsonOrNull: (value: unknown): string | null =>
    value === null || value === undefined ? null : JSON.stringify(value),
  /** SQLite 0/1 flag: `true` binds 1, anything else 0. */
  bit: (value: unknown): number => (value === true ? 1 : 0),
  /** NOT NULL INTEGER: a finite number binds truncated, anything else 0. */
  int: (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.trunc(value)
      : 0,
} as const

// ── Descriptor types ───────────────────────────────────────────────────────

/**
 * One extra physical column written from a mirrored field's value.
 *
 * `ordering AS "order"` is the shape to copy for a quoted alias.
 */
export interface MirrorColumn {
  readonly column: string
  /** SELECT alias; defaults to the physical name. */
  readonly as?: string
  /** Storage codec; defaults to the mirrored entry's codec. */
  readonly codec?: ColumnCodec
}

/** One field of an aggregate's physical row. */
export interface ColumnEntry<Fields extends string = string> {
  /** Physical column name (the primary copy for mirrored fields). */
  readonly column: string
  /** Wire/model field; defaults to the column name. */
  readonly field?: Fields
  /** SELECT alias for the primary column; defaults to the field name. */
  readonly as?: string
  /** Extra physical columns written from the same field. */
  readonly mirrors?: ReadonlyArray<MirrorColumn>
  /** Storage codec both writers share; the default binds the value as-is. */
  readonly codec?: ColumnCodec
  /** Part of the UPDATE SET list (default `true`). */
  readonly updatable?: boolean
  /**
   * Sync-engine-managed column (the server-side attribution, #39): the
   * registry writes and hydrates it, the repos neither read nor write it.
   * `selectList` keeps it out of the repo projection unless the caller asks
   * for it.
   */
  readonly syncManaged?: boolean
}

/** One aggregate's physical table, as data. */
export interface TableDescriptor<Fields extends string = string> {
  readonly table: string
  readonly columns: ReadonlyArray<ColumnEntry<Fields>>
}

/** The wire fields a table's descriptor covers. */
export type TableFields<T extends TableDescriptor<string>> =
  T extends TableDescriptor<infer Fields> ? Fields : never

/**
 * Field → wire value for one row write (before the codec); a field absent is
 * not written. Typing a repo's values helper against this is what catches a
 * field/key typo at compile time.
 */
export type ColumnValues<T extends TableDescriptor<string>> = Readonly<
  Partial<Record<TableFields<T>, unknown>>
>

export const defineTable = <Fields extends string>(
  table: string,
  columns: ReadonlyArray<ColumnEntry<Fields>>,
): TableDescriptor<Fields> => ({ table, columns })

export interface ColumnOptions<Fields extends string = string>
  extends Omit<ColumnEntry<Fields>, 'column' | 'field'> {}

/**
 * Declare one column: `column('time_zone', 'timeZone', { … })`, or
 * `column('title', { codec: columnCodecs.text })` when the wire name is the
 * physical name.
 */
export function column<Fields extends string>(
  name: string,
  field: Fields,
  options?: ColumnOptions<Fields>,
): ColumnEntry<Fields>
export function column<Fields extends string>(
  name: string,
  options?: ColumnOptions<Fields>,
): ColumnEntry<Fields>
export function column<Fields extends string>(
  name: string,
  fieldOrOptions?: Fields | ColumnOptions<Fields>,
  options?: ColumnOptions<Fields>,
): ColumnEntry<Fields> {
  return typeof fieldOrOptions === 'string'
    ? { column: name, field: fieldOrOptions, ...(options ?? {}) }
    : { column: name, ...(fieldOrOptions ?? {}) }
}

// ── Resolved view of an entry ─────────────────────────────────────────────

const fieldOf = <Fields extends string>(entry: ColumnEntry<Fields>): Fields =>
  (entry.field ?? entry.column) as Fields

const codecOf = (entry: ColumnEntry): ColumnCodec =>
  entry.codec ?? (value => value)

/** One physical column with its resolved SELECT alias and codec. */
interface PhysicalColumn {
  readonly column: string
  readonly alias: string
  readonly codec: ColumnCodec
}

const physicalColumns = (
  entry: ColumnEntry,
): ReadonlyArray<PhysicalColumn> => [
  {
    column: entry.column,
    alias: entry.as ?? fieldOf(entry),
    codec: codecOf(entry),
  },
  ...(entry.mirrors ?? []).map(mirror => ({
    column: mirror.column,
    alias: mirror.as ?? mirror.column,
    codec: mirror.codec ?? codecOf(entry),
  })),
]

/**
 * The trusted SELECT projection, aliased to the wire names — never client
 * input.
 *
 * `syncManaged: true` is the registry's form: it adds the columns only the
 * sync engine writes and hydrates. The repos use the default form, so their
 * rows never grow a field the aggregate's model does not have. `prefix`
 * qualifies every column (a joined table's alias).
 */
export const selectList = (
  table: TableDescriptor,
  options?: { readonly syncManaged?: boolean; readonly prefix?: string },
): string => {
  const prefix = options?.prefix ?? ''
  return table.columns
    .flatMap(entry =>
      entry.syncManaged === true && options?.syncManaged !== true
        ? []
        : physicalColumns(entry),
    )
    .map(({ column, alias }) =>
      column === alias
        ? `${prefix}${column}`
        : `${prefix}${column} AS ${alias}`,
    )
    .join(', ')
}

// ── Write builders ────────────────────────────────────────────────────────

/**
 * The entries a write touches: every column whose field the writer supplied
 * a value for. A field absent from `values` is simply not written — the same
 * contract a hand-written statement had.
 */
const writtenEntries = <Fields extends string>(
  table: TableDescriptor<Fields>,
  values: Readonly<Partial<Record<Fields, unknown>>>,
): ReadonlyArray<ColumnEntry<Fields>> =>
  table.columns.filter(entry => fieldOf(entry) in values)

/** A column beyond the descriptor (a spawned task's `recurrence_parent_id`). */
export interface ExtraColumn {
  readonly column: string
  readonly value: unknown
}

export interface InsertStatementInput<Fields extends string = string> {
  /** Field → wire value (before the codec); a field absent is not written. */
  readonly values: Readonly<Partial<Record<Fields, unknown>>>
  /** Columns beyond the descriptor. */
  readonly extra?: ReadonlyArray<ExtraColumn>
  /**
   * `INSERT … SELECT … WHERE ${gate}` instead of `VALUES`, so a lost CAS
   * inserts nothing (a spawned successor, a gated occasion task).
   */
  readonly gate?: Statement.Fragment
  /** Append `ON CONFLICT DO NOTHING`. */
  readonly onConflict?: boolean
  /** Append `RETURNING ${returning}` — the repo's read-back projection. */
  readonly returning?: string
}

/**
 * The parameterized INSERT for one row of `table`.
 *
 * Columns and values come from the descriptor in the same order, so a client
 * can never choose a column name. `gate` turns the VALUES clause into a
 * gated SELECT.
 */
export const insertStatement = <
  A extends object = Record<string, unknown>,
  Fields extends string = string,
>(
  sql: SqlClient.SqlClient,
  table: TableDescriptor<Fields>,
  input: InsertStatementInput<Fields>,
): Statement.Statement<A> => {
  const written = writtenEntries(table, input.values)
  const columnList = [
    ...written.flatMap(entry =>
      physicalColumns(entry).map(physical => physical.column),
    ),
    ...(input.extra ?? []).map(extra => extra.column),
  ].join(', ')
  const tuple = sql.join(', ', true)([
    ...written.flatMap(entry => {
      const raw = input.values[fieldOf(entry)]
      return physicalColumns(entry).map(physical => sql`${physical.codec(raw)}`)
    }),
    ...(input.extra ?? []).map(extra => sql`${extra.value}`),
  ])
  const tail = sql.join(' ', false)([
    ...(input.onConflict === true ? ['ON CONFLICT DO NOTHING'] : []),
    ...(input.returning !== undefined
      ? [sql`RETURNING ${sql.literal(input.returning)}`]
      : []),
  ])
  return input.gate === undefined
    ? sql<A>`
        INSERT INTO ${sql.literal(table.table)} (${sql.literal(columnList)})
        VALUES ${tuple}
        ${tail}
      `
    : sql<A>`
        INSERT INTO ${sql.literal(table.table)} (${sql.literal(columnList)})
        SELECT ${tuple} WHERE ${input.gate}
        ${tail}
      `
}

export interface UpdateStatementInput<Fields extends string = string> {
  /** The row id; the statement's WHERE key. */
  readonly id: string
  /** Field → wire value (before the codec); a field absent is not written. */
  readonly values: Readonly<Partial<Record<Fields, unknown>>>
  /**
   * The compare-and-set version (`WHERE id = … AND version = …`); omit for a
   * plain by-id update of a row the caller already holds.
   */
  readonly expectedVersion?: number
  /** Append `RETURNING ${returning}` — the repo's read-back projection. */
  readonly returning?: string
}

/**
 * The parameterized full-row UPDATE for one row of `table`.
 *
 * The SET list is the descriptor's updatable columns the writer supplied a
 * value for; identity and bookkeeping columns (`id`, `type`, `owner_id`,
 * `created_at`, …) are flagged `updatable: false` and never appear.
 */
export const updateStatement = <
  A extends object = Record<string, unknown>,
  Fields extends string = string,
>(
  sql: SqlClient.SqlClient,
  table: TableDescriptor<Fields>,
  input: UpdateStatementInput<Fields>,
): Statement.Statement<A> => {
  const set = sql.join(', ', false)(
    writtenEntries(table, input.values)
      .filter(entry => entry.updatable !== false)
      .flatMap(entry => {
        const raw = input.values[fieldOf(entry)]
        return physicalColumns(entry).map(
          physical =>
            sql`${sql.literal(physical.column)} = ${physical.codec(raw)}`,
        )
      }),
  )
  const tail =
    input.returning !== undefined
      ? sql`RETURNING ${sql.literal(input.returning)}`
      : sql``
  return input.expectedVersion === undefined
    ? sql<A>`
        UPDATE ${sql.literal(table.table)} SET ${set}
        WHERE id = ${input.id}
        ${tail}
      `
    : sql<A>`
        UPDATE ${sql.literal(table.table)} SET ${set}
        WHERE id = ${input.id} AND version = ${input.expectedVersion}
        ${tail}
      `
}
