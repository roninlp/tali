import { Schema } from 'effect'
import { Visibility } from '../common.js'
import {
  ListCheckedPlacement,
  ListId,
  ListItemId,
  ListItemSort,
  NonEmptyString,
  TagIds,
  conflictFields,
  createEnvelope,
  forbiddenFields,
  mutationEnvelope,
  notFoundFields,
  updateEnvelope,
  validationFields,
} from './common.js'
import { List } from './list.js'
import { ListItem as PlanningListItem } from './list-item.js'

/**
 * ListService contract (ticket #39; FR-LIST-01/02/03).
 *
 * The wire/service layer for lists and their items. Every mutation carries a
 * `clientMutationId` (the same replay key the task/note services use) and, for
 * items, the client-mintable UUID v7 id so an offline create can be pushed
 * later without changing identity.
 *
 * The service is server-authoritative: versions, timestamps and `checkedAt`
 * are stamped on write. The client renders from its mirror and the sync engine
 * reconciles, exactly like tasks and notes.
 */

// ── Typed errors (`docs/error-model-draft.md` §2) ────────────────────────

export class ListNotFound extends Schema.TaggedError<ListNotFound>()(
  'ListNotFound',
  notFoundFields(Schema.String),
) {}

/**
 * Named `ListEntryNotFound` in TypeScript because the pre-Slice-2 scaffold
 * still exports a `ListItemNotFound` class; the wire tag stays entity-specific.
 */
export class ListEntryNotFound extends Schema.TaggedError<ListEntryNotFound>()(
  'ListItemNotFound',
  notFoundFields(Schema.String),
) {}

/** The row exists but this viewer may not read/write it (private/shared). */
export class ListForbidden extends Schema.TaggedError<ListForbidden>()(
  'ListForbidden',
  forbiddenFields,
) {}

/** Field-level validation (empty title, order item from another list, …). */
export class ListValidationError extends Schema.TaggedError<ListValidationError>()(
  'ListValidationError',
  validationFields,
) {}

/** Another writer won the version CAS; the caller may retry. */
export class ListConflict extends Schema.TaggedError<ListConflict>()(
  'ListConflict',
  conflictFields,
) {}

export const ListServiceError = Schema.Union([
  ListNotFound,
  ListEntryNotFound,
  ListForbidden,
  ListValidationError,
  ListConflict,
])
export type ListServiceError = Schema.Schema.Type<typeof ListServiceError>

// ── List inputs ──────────────────────────────────────────────────────────

export const ListCreateInput = createEnvelope(ListId, {
  title: NonEmptyString,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  icon: Schema.optional(Schema.NullOr(Schema.String)),
  sort: Schema.optional(ListItemSort),
  checkedPlacement: Schema.optional(ListCheckedPlacement),
  visibility: Schema.optional(Visibility),
})
export type ListCreateInput = Schema.Schema.Type<typeof ListCreateInput>

export const ListPatch = Schema.Struct({
  title: Schema.optional(NonEmptyString),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  icon: Schema.optional(Schema.NullOr(Schema.String)),
  sort: Schema.optional(ListItemSort),
  checkedPlacement: Schema.optional(ListCheckedPlacement),
  visibility: Schema.optional(Visibility),
})
export type ListPatch = Schema.Schema.Type<typeof ListPatch>

export const ListUpdateInput = updateEnvelope(ListId, ListPatch)
export type ListUpdateInput = Schema.Schema.Type<typeof ListUpdateInput>

/** Delete/archive is the common soft delete (`deletedAt` + a delete feed op). */
export const ListMutationInput = mutationEnvelope(ListId)
export type ListMutationInput = Schema.Schema.Type<typeof ListMutationInput>

// ── ListItem inputs ──────────────────────────────────────────────────────

export const ListItemCreateInput = createEnvelope(ListItemId, {
  listId: ListId,
  /** The real aggregate calls it `name`; the legacy wire mirrors it as `title`. */
  name: NonEmptyString,
  order: Schema.optional(Schema.Int),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  tagIds: Schema.optional(TagIds),
})
export type ListItemCreateInput = Schema.Schema.Type<typeof ListItemCreateInput>

/**
 * Continuous-entry batch append: five Enters can be committed either as five
 * local writes (the normal offline path) or one server batch. Item ids are
 * optional so a caller that has already minted them keeps identity; the
 * service derives one replay key per item from the batch key.
 */
export const ListItemsAppendInput = Schema.Struct({
  listId: ListId,
  clientMutationId: Schema.String,
  items: Schema.Array(
    Schema.Struct({
      id: Schema.optional(ListItemId),
      name: NonEmptyString,
      color: Schema.optional(Schema.NullOr(Schema.String)),
      tagIds: Schema.optional(TagIds),
    }),
  ),
})
export type ListItemsAppendInput = Schema.Schema.Type<
  typeof ListItemsAppendInput
>

export const ListItemPatch = Schema.Struct({
  name: Schema.optional(NonEmptyString),
  order: Schema.optional(Schema.Int),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  tagIds: Schema.optional(TagIds),
  visibility: Schema.optional(Visibility),
})
export type ListItemPatch = Schema.Schema.Type<typeof ListItemPatch>

export const ListItemUpdateInput = updateEnvelope(ListItemId, ListItemPatch)
export type ListItemUpdateInput = Schema.Schema.Type<typeof ListItemUpdateInput>

/** Idempotent check/uncheck; `checkedAt` is server-stamped audit. */
export const ListItemCheckInput = Schema.Struct({
  id: ListItemId,
  clientMutationId: Schema.String,
  checked: Schema.Boolean,
})
export type ListItemCheckInput = Schema.Schema.Type<typeof ListItemCheckInput>

export const ListItemMutationInput = mutationEnvelope(ListItemId)
export type ListItemMutationInput = Schema.Schema.Type<
  typeof ListItemMutationInput
>

/**
 * Manual reorder: the complete item order for one list. The service rewrites
 * the ordering integers and bumps every changed item's version in one batch.
 */
export const ListReorderInput = Schema.Struct({
  listId: ListId,
  clientMutationId: Schema.String,
  itemIds: Schema.Array(ListItemId),
})
export type ListReorderInput = Schema.Schema.Type<typeof ListReorderInput>

export const ListItemsQuery = Schema.Struct({
  listId: ListId,
})
export type ListItemsQuery = Schema.Schema.Type<typeof ListItemsQuery>

/** The aggregate shapes the RPC contract returns. */
export const ListResponse = List
export type ListResponse = Schema.Schema.Type<typeof ListResponse>

export const ListItemResponse = PlanningListItem
export type ListItemResponse = Schema.Schema.Type<typeof ListItemResponse>
