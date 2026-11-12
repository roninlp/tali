import { SqlClient, Statement } from 'effect/sql'
import type { UserId } from '@tali/domain'

/**
 * The ADR-0011 read scope, defined once.
 *
 * Every user-facing read in this package is scoped the same way: the viewer's
 * household, live rows only, and only the rows the viewer owns or that are
 * `shared` with the household. The predicate used to be hand-written in each
 * repo and had drifted — the reminder reads dropped `deleted_at` and
 * compensated at the call site, and the aliased queries (`n.`, `t.`) spelled
 * the columns differently — so it lives here now.
 *
 * Values stay bound parameters; only the column names are rendered as
 * identifiers (`sql.literal`), and only from the trusted shape below.
 *
 * The system paths that deliberately omit part of it (the sync registry, the
 * pre-ADR-0011 `list_items` reader, the household-wide scheduler reads) keep
 * their own filters and say why at the query.
 */

/** `exclude` (default) = live rows; `only` = tombstones; `include` = both. */
export type TrashFilter = 'exclude' | 'only' | 'include'

export interface ScopeColumns {
  readonly household: string
  readonly owner: string
  readonly visibility: string
  readonly deleted: string
}

/** The column names every table in this package inherits from the base row. */
export const DEFAULT_SCOPE_COLUMNS: ScopeColumns = {
  household: 'household_id',
  owner: 'owner_id',
  visibility: 'visibility',
  deleted: 'deleted_at',
}

export interface VisibleScopeOptions {
  /** Table alias, e.g. `n` renders `n.household_id`. */
  readonly alias?: string
  /** `exclude` (default) = live rows; `only` = tombstones; `include` = both. */
  readonly trash?: TrashFilter
  readonly columns?: Partial<ScopeColumns>
}

/**
 * `household = ? AND deleted_at IS NULL AND (owner = ? OR visibility = 'shared')`
 *
 * The clause order and the parenthesising are part of the contract: callers
 * append their own predicates with `AND` around this fragment.
 */
export const visibleScopeSql = (
  sql: SqlClient.SqlClient,
  input: { readonly householdId: string; readonly userId: UserId },
  options?: VisibleScopeOptions,
): Statement.Fragment => {
  const columns: ScopeColumns = {
    ...DEFAULT_SCOPE_COLUMNS,
    ...options?.columns,
  }
  const alias = options?.alias
  const column = (name: string): Statement.Fragment =>
    sql.literal(alias === undefined ? name : `${alias}.${name}`)

  const household = column(columns.household)
  const owner = column(columns.owner)
  const visibility = column(columns.visibility)
  const deleted = column(columns.deleted)

  // Each optional clause carries its own leading `AND`, so `include` renders
  // just the two mandatory clauses without a dangling operator.
  const trash = options?.trash ?? 'exclude'
  const deletedClause =
    trash === 'exclude'
      ? sql`AND ${deleted} IS NULL`
      : trash === 'only'
        ? sql`AND ${deleted} IS NOT NULL`
        : sql``

  return sql`
    ${household} = ${input.householdId}
    ${deletedClause}
    AND (${owner} = ${input.userId} OR ${visibility} = 'shared')
  `
}
