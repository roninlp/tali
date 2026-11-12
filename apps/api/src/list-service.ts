import { Context, Effect, Layer, Option } from 'effect'
import {
  type HouseholdId,
  List,
  ListCheckedPlacement,
  ListConflict,
  type ListCreateInput,
  ListEntryNotFound,
  ListForbidden,
  type ListItemCheckInput,
  type ListItemCreateInput,
  type ListItemMutationInput,
  type ListItemPatch,
  type ListItemUpdateInput,
  type ListItemsAppendInput,
  type ListItemsQuery,
  type ListMutationInput,
  type ListPatch,
  type ListReorderInput,
  ListServiceError,
  ListValidationError,
  type ListUpdateInput,
  ListNotFound,
  PlanningListItem as ListItem,
  type TagId,
  type UserId,
  resolveCreateVisibility,
  resolveInheritedVisibility,
  uuidV7,
  type Visibility,
} from '@tali/domain'
import {
  ListRepo,
  ListRepoLive,
  type SyncEntityState,
  SyncRepo,
  SyncRepoLive,
  TagRepo,
  TagRepoLive,
  PlanningListItemRepo,
  PlanningListItemRepoLive,
} from '@tali/sql'
import { readScoped } from './row-scope.js'
import { casUpdate } from './cas.js'
import { makeSyncKit } from './sync-write.js'
import { loadAssignableTags } from './tag-guard.js'

/**
 * `ListService` — the List/ListItem vertical (ticket #39; FR-LIST-01/02/03).
 *
 * ## Write path
 *
 * Every mutation is one `D1Client.batch()` built from the #34 sync primitives
 * (`writeEntity` + gated `appendFeed` + gated `recordApplied`), exactly like
 * `TaskService` and `NoteService`. That means the row version, the household
 * change feed and the replay ledger always move together: the RPC path and the
 * offline `/sync/push` path produce indistinguishable state.
 *
 * ## Sharing
 *
 * A list/items are visible when shared, or when this user owns them. A private
 * list is owner-only; an item under a private list inherits that restriction.
 * Reorder and delete operate on the whole list server-side (including a
 * spouse's private rows) but never return another user's private data.
 *
 * ## Ordering
 *
 * `order` is a manual integer. Appends use `max(order) + 1`; reorder rewrites
 * the complete sequence 1..n. Every changed item bumps its own `version`, and
 * the owning list's version bumps once per reorder so a stale list edit can be
 * detected.
 */

export interface ListViewer {
  readonly userId: UserId
  readonly householdId: HouseholdId
  /** The user's global checked-item default, used when a list omits one. */
  readonly defaultCheckedPlacement?: ListCheckedPlacement
}

export interface ListServiceApi {
  readonly create: (
    viewer: ListViewer,
    input: ListCreateInput,
    now?: string,
  ) => Effect.Effect<List, ListServiceError>
  readonly get: (
    viewer: ListViewer,
    id: List['id'],
  ) => Effect.Effect<List, ListServiceError>
  readonly update: (
    viewer: ListViewer,
    input: ListUpdateInput,
    now?: string,
  ) => Effect.Effect<List, ListServiceError>
  readonly remove: (
    viewer: ListViewer,
    input: ListMutationInput,
    now?: string,
  ) => Effect.Effect<List, ListServiceError>
  readonly list: (
    viewer: ListViewer,
  ) => Effect.Effect<ReadonlyArray<List>, ListServiceError>
  readonly listItems: (
    viewer: ListViewer,
    input: ListItemsQuery,
  ) => Effect.Effect<ReadonlyArray<ListItem>, ListServiceError>
  readonly createItem: (
    viewer: ListViewer,
    input: ListItemCreateInput,
    now?: string,
  ) => Effect.Effect<ListItem, ListServiceError>
  readonly appendItems: (
    viewer: ListViewer,
    input: ListItemsAppendInput,
    now?: string,
  ) => Effect.Effect<ReadonlyArray<ListItem>, ListServiceError>
  readonly updateItem: (
    viewer: ListViewer,
    input: ListItemUpdateInput,
    now?: string,
  ) => Effect.Effect<ListItem, ListServiceError>
  readonly setItemChecked: (
    viewer: ListViewer,
    input: ListItemCheckInput,
    now?: string,
  ) => Effect.Effect<ListItem, ListServiceError>
  readonly deleteItem: (
    viewer: ListViewer,
    input: ListItemMutationInput,
    now?: string,
  ) => Effect.Effect<ListItem, ListServiceError>
  readonly reorder: (
    viewer: ListViewer,
    input: ListReorderInput,
    now?: string,
  ) => Effect.Effect<ReadonlyArray<ListItem>, ListServiceError>
}

const invalid = (
  field: string,
  message: string,
): Effect.Effect<never, ListValidationError> =>
  Effect.fail(new ListValidationError({ issues: [{ field, message }] }))

const sameTags = (a: ReadonlyArray<TagId>, b: ReadonlyArray<TagId>): boolean =>
  a.length === b.length && a.every((tagId, index) => tagId === b[index])

const itemWire = (item: ListItem): Record<string, unknown> => ({
  ...item,
  // Keep both the legacy sync vocabulary and the real #33 field names current
  // so a pull hydrates whichever one the reader uses.
  title: item.name,
  checked: item.done,
  sortOrder: item.order,
  name: item.name,
  done: item.done,
  ordering: item.order,
})

interface EntityGroup {
  readonly state: SyncEntityState
  readonly expectedVersion: number | null
  readonly clientMutationId: string
  readonly op?: 'upsert' | 'delete'
  readonly tagChanges?: {
    readonly previous: ReadonlyArray<TagId>
    readonly next: ReadonlyArray<TagId>
  }
}

export class ListService extends Context.Service<ListService>()('ListService', {
  make: Effect.gen(function* () {
    const lists = yield* ListRepo
    const items = yield* PlanningListItemRepo
    const tags = yield* TagRepo
    const sync = yield* SyncRepo

    const kit = makeSyncKit<ListServiceError>({ sync, invalid })

    /**
     * The list aggregate + the server-stamped last writer (#39). The List
     * model does not carry attribution, so it is added after the same schema
     * boundary the sync push uses; the registry writes/reads the column.
     */
    const listState = (list: List, writerId: string): SyncEntityState =>
      kit.stateOf('list', list, {
        decorate: data => ({ ...data, lastWriterId: writerId }),
      })

    const itemState = (item: ListItem, writerId: string): SyncEntityState =>
      kit.stateOf('listItem', item, {
        encode: itemWire,
        decorate: data => ({ ...data, lastWriterId: writerId }),
      })

    const appliedMutations = (viewer: ListViewer, ids: ReadonlyArray<string>) =>
      sync
        .findApplied({
          householdId: viewer.householdId,
          clientMutationIds: ids,
        })
        .pipe(Effect.orDie)

    /**
     * One batch over N entity groups. Groups already recorded for this
     * mutation id are skipped, so a replay after a lost response cannot write
     * twice; a group whose id belongs to another row is rejected. The returned
     * set reports every group the ledger records, replayed or fresh.
     */
    const commitGroups = (
      viewer: ListViewer,
      groups: ReadonlyArray<EntityGroup>,
      now: string,
    ) =>
      kit.commitEntries({
        householdId: viewer.householdId,
        skipApplied: true,
        now,
        entries: groups.map(group => ({
          state: group.state,
          expectedVersion: group.expectedVersion,
          clientMutationId: group.clientMutationId,
          op: group.op,
          extra: (state: SyncEntityState) =>
            group.tagChanges !== undefined &&
            !sameTags(group.tagChanges.previous, group.tagChanges.next)
              ? [
                  items.detachTagsIfVersion({
                    itemId: state.entityId as ListItem['id'],
                    version: state.version,
                    updatedAt: state.updatedAt,
                  }),
                  ...group.tagChanges.next.map(tagId =>
                    items.attachTagIfVersion({
                      itemId: state.entityId as ListItem['id'],
                      tagId,
                      householdId: viewer.householdId,
                      createdAt: now,
                      version: state.version,
                      updatedAt: state.updatedAt,
                    }),
                  ),
                ]
              : [],
        })),
      })

    /**
     * One read path for lists. A normal read rejects a tombstone; a replay
     * passes `includeTrashed` so a retried delete hands the stored row back
     * instead of `ListNotFound`, exactly like the event/note replay guards.
     */
    const readList = (
      viewer: ListViewer,
      id: List['id'],
      includeTrashed = false,
    ): Effect.Effect<List, ListServiceError> =>
      readScoped({
        viewer,
        id,
        find: lists.findById,
        includeTrashed,
        // A tombstone reads as missing before the household/owner checks.
        trash: 'first',
        onViolation: violation =>
          violation === 'notFound' || violation === 'trashed'
            ? new ListNotFound({ id })
            : new ListForbidden({ id, reason: violation }),
      })

    const loadList = (
      viewer: ListViewer,
      id: List['id'],
    ): Effect.Effect<List, ListServiceError> => readList(viewer, id)

    const readItem = (
      viewer: ListViewer,
      id: ListItem['id'],
      includeTrashed = false,
    ): Effect.Effect<ListItem, ListServiceError> =>
      Effect.gen(function* () {
        const item = yield* readScoped({
          viewer,
          id,
          find: items.findById,
          includeTrashed,
          trash: 'first',
          onViolation: violation =>
            violation === 'notFound' || violation === 'trashed'
              ? new ListEntryNotFound({ id })
              : new ListForbidden({ id, reason: violation }),
        })
        // The parent list's visibility is a second gate: an item can never be
        // read through a private list owned by the other member. A replayed
        // item delete also tolerates a tombstoned parent, because the list
        // delete may have landed first; the household/owner rule still holds.
        yield* readList(viewer, item.listId, includeTrashed)
        return item
      })

    const loadItem = (
      viewer: ListViewer,
      id: ListItem['id'],
    ): Effect.Effect<ListItem, ListServiceError> => readItem(viewer, id)

    const requireTags = (
      viewer: ListViewer,
      tagIds: ReadonlyArray<TagId>,
    ): Effect.Effect<void, ListValidationError> =>
      loadAssignableTags(tags, viewer, tagIds).pipe(
        Effect.mapError(issue => new ListValidationError({ issues: [issue] })),
        Effect.asVoid,
      )

    /**
     * An item inherits its list's visibility and may only be narrower (ADR-0011):
     * a private item is allowed inside a shared list, but never a shared item
     * inside a private list. The rule is shared with the sync registry.
     */
    const itemVisibility = (
      parent: List,
      requested: Visibility | undefined,
    ): Effect.Effect<Visibility, ListValidationError> => {
      const resolved = resolveInheritedVisibility(
        'listItem',
        parent.visibility,
        requested,
      )
      return resolved._tag === 'resolved'
        ? Effect.succeed(resolved.visibility)
        : invalid(
            'visibility',
            'an item cannot be shared inside a private list',
          )
    }

    /** Replay guard for one list: same mutation id + same row ⇒ stored row. */
    const replayList = (
      viewer: ListViewer,
      clientMutationId: string,
      expectedId?: List['id'],
    ): Effect.Effect<Option.Option<List>, ListServiceError> =>
      Effect.gen(function* () {
        const prior = yield* appliedMutations(viewer, [clientMutationId])
        const row = prior.get(clientMutationId)
        if (row === undefined) return Option.none()
        if (kit.reusedMutationId(row, { entityType: 'list', id: expectedId })) {
          return yield* kit.reusedMutationIdError(expectedId ?? row.entityId)
        }
        // Same household/owner rules as any read, but a delete replay needs
        // the stored tombstone back.
        return Option.some(
          yield* readList(viewer, row.entityId as List['id'], true),
        )
      })

    const replayItem = (
      viewer: ListViewer,
      clientMutationId: string,
      expectedId?: ListItem['id'],
    ): Effect.Effect<Option.Option<ListItem>, ListServiceError> =>
      Effect.gen(function* () {
        const prior = yield* appliedMutations(viewer, [clientMutationId])
        const row = prior.get(clientMutationId)
        if (row === undefined) return Option.none()
        if (
          kit.reusedMutationId(row, { entityType: 'listItem', id: expectedId })
        ) {
          return yield* kit.reusedMutationIdError(expectedId ?? row.entityId)
        }
        return Option.some(
          yield* readItem(viewer, row.entityId as ListItem['id'], true),
        )
      })

    const listItems = (
      viewer: ListViewer,
      input: ListItemsQuery,
    ): Effect.Effect<ReadonlyArray<ListItem>, ListServiceError> =>
      Effect.gen(function* () {
        yield* loadList(viewer, input.listId)
        return yield* items
          .listByList({
            listId: input.listId,
            householdId: viewer.householdId,
            userId: viewer.userId,
          })
          .pipe(Effect.orDie)
      })

    const nextOrder = (listId: List['id'], householdId: string) =>
      Effect.map(
        items.listAllForList({ listId, householdId }).pipe(Effect.orDie),
        rows => rows.reduce((max, item) => Math.max(max, item.order), 0) + 1,
      )

    // ── Lists ────────────────────────────────────────────────────────────

    const create = (
      viewer: ListViewer,
      input: ListCreateInput,
      now: string = new Date().toISOString(),
    ): Effect.Effect<List, ListServiceError> =>
      Effect.gen(function* () {
        const replayed = yield* replayList(
          viewer,
          input.clientMutationId,
          input.id,
        )
        if (Option.isSome(replayed)) return replayed.value

        const list = new List({
          id: (input.id ?? uuidV7()) as List['id'],
          type: 'list',
          title: input.title.trim(),
          description: input.description ?? null,
          ownerId: viewer.userId,
          householdId: viewer.householdId,
          visibility: resolveCreateVisibility('list', input.visibility),
          color: input.color ?? null,
          icon: input.icon ?? null,
          sort: input.sort ?? 'manual',
          checkedPlacement:
            input.checkedPlacement ??
            viewer.defaultCheckedPlacement ??
            'bottom',
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null,
        })
        if (list.title === '')
          return yield* invalid('title', 'a list needs a title')

        const applied = yield* commitGroups(
          viewer,
          [
            {
              state: listState(list, viewer.userId),
              expectedVersion: null,
              clientMutationId: input.clientMutationId,
            },
          ],
          now,
        )
        if (!applied.has(input.clientMutationId)) {
          return yield* new ListConflict({ id: list.id })
        }
        return list
      })

    const get = (
      viewer: ListViewer,
      id: List['id'],
    ): Effect.Effect<List, ListServiceError> => loadList(viewer, id)

    const update = (
      viewer: ListViewer,
      input: ListUpdateInput,
      now: string = new Date().toISOString(),
    ): Effect.Effect<List, ListServiceError> =>
      Effect.gen(function* () {
        const replayed = yield* replayList(
          viewer,
          input.clientMutationId,
          input.id,
        )
        if (Option.isSome(replayed)) return replayed.value

        return yield* casUpdate({
          read: loadList(viewer, input.id),
          plan: current =>
            Effect.gen(function* () {
              const patch: ListPatch = input.patch
              if (patch.title !== undefined && patch.title.trim() === '') {
                return yield* invalid('title', 'a list needs a title')
              }
              // Only the creator can flip a shared list to private; the other
              // member must not be able to lock the owner out.
              if (
                patch.visibility === 'private' &&
                current.ownerId !== viewer.userId
              ) {
                return yield* invalid(
                  'visibility',
                  'only the list owner can make it private',
                )
              }
              const next = new List({
                ...current,
                title: patch.title?.trim() ?? current.title,
                description:
                  patch.description !== undefined
                    ? patch.description
                    : current.description,
                color: patch.color !== undefined ? patch.color : current.color,
                icon: patch.icon !== undefined ? patch.icon : current.icon,
                sort: patch.sort ?? current.sort,
                checkedPlacement:
                  patch.checkedPlacement ?? current.checkedPlacement,
                visibility: patch.visibility ?? current.visibility,
                version: current.version + 1,
                updatedAt: now,
              })
              if (
                next.title === current.title &&
                next.description === current.description &&
                next.color === current.color &&
                next.icon === current.icon &&
                next.sort === current.sort &&
                next.checkedPlacement === current.checkedPlacement &&
                next.visibility === current.visibility
              ) {
                return null
              }
              return next
            }),
          write: (current, next) =>
            commitGroups(
              viewer,
              [
                {
                  state: listState(next, viewer.userId),
                  expectedVersion: current.version,
                  clientMutationId: input.clientMutationId,
                },
              ],
              now,
            ).pipe(Effect.map(applied => applied.has(input.clientMutationId))),
          conflict: () => new ListConflict({ id: input.id }),
        })
      })

    const remove = (
      viewer: ListViewer,
      input: ListMutationInput,
      now: string = new Date().toISOString(),
    ): Effect.Effect<List, ListServiceError> =>
      Effect.gen(function* () {
        // The delete commits its list group under `${id}:list`, so the replay
        // must look up that same ledger key (a plain id may belong to a
        // create/update) — otherwise a lost response would surface as
        // ListNotFound on the tombstoned row.
        const listKey = `${input.clientMutationId}:list`
        const replayed = yield* replayList(viewer, listKey, input.id)
        if (Option.isSome(replayed)) return replayed.value

        return yield* casUpdate({
          read: loadList(viewer, input.id),
          plan: current =>
            Effect.succeed(
              new List({
                ...current,
                version: current.version + 1,
                updatedAt: now,
                deletedAt: now,
              }),
            ),
          write: (current, next) =>
            Effect.gen(function* () {
              // Cascade the soft delete to every live item, including a
              // spouse's private rows, so nothing outlives the list in their
              // mirror.
              const children = yield* items
                .listAllForList({
                  listId: current.id,
                  householdId: viewer.householdId,
                })
                .pipe(Effect.orDie)
              const groups: Array<EntityGroup> = [
                {
                  state: listState(next, viewer.userId),
                  expectedVersion: current.version,
                  clientMutationId: listKey,
                  op: 'delete',
                },
                ...children.map(item => ({
                  state: itemState(
                    new ListItem({
                      ...item,
                      version: item.version + 1,
                      updatedAt: now,
                      deletedAt: now,
                    }),
                    viewer.userId,
                  ),
                  expectedVersion: item.version,
                  clientMutationId: `${input.clientMutationId}:item:${item.id}`,
                  op: 'delete' as const,
                })),
              ]
              const applied = yield* commitGroups(viewer, groups, now)
              return applied.has(listKey)
            }),
          conflict: () => new ListConflict({ id: input.id }),
        })
      })

    const list = (
      viewer: ListViewer,
    ): Effect.Effect<ReadonlyArray<List>, ListServiceError> =>
      lists
        .listVisible({ householdId: viewer.householdId, userId: viewer.userId })
        .pipe(Effect.orDie)

    // ── List items ───────────────────────────────────────────────────────

    const createItem = (
      viewer: ListViewer,
      input: ListItemCreateInput,
      now: string = new Date().toISOString(),
    ): Effect.Effect<ListItem, ListServiceError> =>
      Effect.gen(function* () {
        const replayed = yield* replayItem(
          viewer,
          input.clientMutationId,
          input.id,
        )
        if (Option.isSome(replayed)) return replayed.value
        const parent = yield* loadList(viewer, input.listId)
        yield* requireTags(viewer, input.tagIds ?? [])
        const name = input.name.trim()
        if (name === '') return yield* invalid('name', 'an item needs a name')
        // The create schema has no `visibility` (the item inherits the list),
        // so the resolved value is the parent's.
        const visibility = yield* itemVisibility(parent, undefined)

        const item = new ListItem({
          id: (input.id ?? uuidV7()) as ListItem['id'],
          type: 'listItem',
          listId: parent.id,
          name,
          done: false,
          order:
            input.order ?? (yield* nextOrder(parent.id, viewer.householdId)),
          checkedAt: null,
          tagIds: input.tagIds ?? [],
          ownerId: viewer.userId,
          householdId: viewer.householdId,
          visibility,
          color: input.color ?? null,
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null,
        })
        const applied = yield* commitGroups(
          viewer,
          [
            {
              state: itemState(item, viewer.userId),
              expectedVersion: null,
              clientMutationId: input.clientMutationId,
              tagChanges: { previous: [], next: item.tagIds },
            },
          ],
          now,
        )
        if (!applied.has(input.clientMutationId)) {
          return yield* new ListConflict({ id: item.id })
        }
        return item
      })

    const appendItems = (
      viewer: ListViewer,
      input: ListItemsAppendInput,
      now: string = new Date().toISOString(),
    ): Effect.Effect<ReadonlyArray<ListItem>, ListServiceError> =>
      Effect.gen(function* () {
        const parent = yield* loadList(viewer, input.listId)
        if (input.items.length === 0) {
          return yield* invalid('items', 'append at least one item')
        }
        for (const entry of input.items) {
          if (entry.name.trim() === '') {
            return yield* invalid('name', 'an item needs a name')
          }
        }
        for (const entry of input.items) {
          yield* requireTags(viewer, entry.tagIds ?? [])
        }

        // A lost response replays the same batch key. Child keys are positional
        // so a retry still recognises a batch whose ids the server minted.
        const replayKeys = input.items.map(
          (_entry, index) => `${input.clientMutationId}:item:${index}`,
        )
        const prior = yield* appliedMutations(viewer, replayKeys)
        if (prior.size > 0)
          return yield* listItems(viewer, { listId: input.listId })

        const baseOrder = yield* nextOrder(parent.id, viewer.householdId)
        const visibility = yield* itemVisibility(parent, undefined)
        const created = input.items.map(
          (entry, index) =>
            new ListItem({
              id: (entry.id ?? uuidV7()) as ListItem['id'],
              type: 'listItem',
              listId: parent.id,
              name: entry.name.trim(),
              done: false,
              order: baseOrder + index,
              checkedAt: null,
              tagIds: entry.tagIds ?? [],
              ownerId: viewer.userId,
              householdId: viewer.householdId,
              visibility,
              color: entry.color ?? null,
              createdAt: now,
              updatedAt: now,
              version: 1,
              deletedAt: null,
            }),
        )
        yield* commitGroups(
          viewer,
          created.map((item, index) => ({
            state: itemState(item, viewer.userId),
            expectedVersion: null,
            clientMutationId: `${input.clientMutationId}:item:${index}`,
            tagChanges: { previous: [], next: item.tagIds },
          })),
          now,
        )
        return yield* listItems(viewer, { listId: input.listId })
      })

    const updateItem = (
      viewer: ListViewer,
      input: ListItemUpdateInput,
      now: string = new Date().toISOString(),
    ): Effect.Effect<ListItem, ListServiceError> =>
      Effect.gen(function* () {
        const replayed = yield* replayItem(
          viewer,
          input.clientMutationId,
          input.id,
        )
        if (Option.isSome(replayed)) return replayed.value

        return yield* casUpdate({
          read: loadItem(viewer, input.id),
          plan: current =>
            Effect.gen(function* () {
              const patch: ListItemPatch = input.patch
              if (patch.name !== undefined && patch.name.trim() === '') {
                return yield* invalid('name', 'an item needs a name')
              }
              if (patch.tagIds !== undefined)
                yield* requireTags(viewer, patch.tagIds)
              // Shared means co-edit; un-sharing is the owner's alone
              // (ADR-0011).
              if (
                patch.visibility === 'private' &&
                current.ownerId !== viewer.userId
              ) {
                return yield* invalid(
                  'visibility',
                  'only the item owner can make it private',
                )
              }
              const parent = yield* loadList(viewer, current.listId)
              // A no-op field edit is still a write: a legacy shared item in a
              // private list must converge to private, exactly as the sync
              // ceiling does, rather than stay shared because the patch omitted
              // visibility.
              const visibility =
                patch.visibility !== undefined
                  ? yield* itemVisibility(parent, patch.visibility)
                  : parent.visibility === 'private'
                    ? 'private'
                    : current.visibility
              const next = new ListItem({
                ...current,
                name: patch.name?.trim() ?? current.name,
                order: patch.order ?? current.order,
                color: patch.color !== undefined ? patch.color : current.color,
                tagIds: patch.tagIds ?? current.tagIds,
                visibility,
                version: current.version + 1,
                updatedAt: now,
              })
              if (
                next.name === current.name &&
                next.order === current.order &&
                next.color === current.color &&
                next.visibility === current.visibility &&
                sameTags(next.tagIds, current.tagIds)
              ) {
                return null
              }
              return next
            }),
          write: (current, next) =>
            commitGroups(
              viewer,
              [
                {
                  state: itemState(next, viewer.userId),
                  expectedVersion: current.version,
                  clientMutationId: input.clientMutationId,
                  tagChanges: { previous: current.tagIds, next: next.tagIds },
                },
              ],
              now,
            ).pipe(Effect.map(applied => applied.has(input.clientMutationId))),
          conflict: () => new ListConflict({ id: input.id }),
        })
      })

    const setItemChecked = (
      viewer: ListViewer,
      input: ListItemCheckInput,
      now: string = new Date().toISOString(),
    ): Effect.Effect<ListItem, ListServiceError> =>
      Effect.gen(function* () {
        const replayed = yield* replayItem(
          viewer,
          input.clientMutationId,
          input.id,
        )
        if (Option.isSome(replayed)) return replayed.value

        return yield* casUpdate({
          read: loadItem(viewer, input.id),
          plan: current =>
            Effect.gen(function* () {
              // Idempotent: re-checking a checked item (or unchecking an
              // unchecked one) writes nothing and does not mint a version.
              if (current.done === input.checked) return null
              const parent = yield* loadList(viewer, current.listId)
              return new ListItem({
                ...current,
                done: input.checked,
                checkedAt: input.checked ? now : null,
                visibility:
                  parent.visibility === 'private'
                    ? 'private'
                    : current.visibility,
                version: current.version + 1,
                updatedAt: now,
              })
            }),
          write: (current, next) =>
            commitGroups(
              viewer,
              [
                {
                  state: itemState(next, viewer.userId),
                  expectedVersion: current.version,
                  clientMutationId: input.clientMutationId,
                },
              ],
              now,
            ).pipe(Effect.map(applied => applied.has(input.clientMutationId))),
          conflict: () => new ListConflict({ id: input.id }),
        })
      })

    const deleteItem = (
      viewer: ListViewer,
      input: ListItemMutationInput,
      now: string = new Date().toISOString(),
    ): Effect.Effect<ListItem, ListServiceError> =>
      Effect.gen(function* () {
        const replayed = yield* replayItem(
          viewer,
          input.clientMutationId,
          input.id,
        )
        if (Option.isSome(replayed)) return replayed.value

        return yield* casUpdate({
          read: loadItem(viewer, input.id),
          plan: current =>
            Effect.succeed(
              new ListItem({
                ...current,
                version: current.version + 1,
                updatedAt: now,
                deletedAt: now,
              }),
            ),
          write: (current, next) =>
            commitGroups(
              viewer,
              [
                {
                  state: itemState(next, viewer.userId),
                  expectedVersion: current.version,
                  clientMutationId: input.clientMutationId,
                  op: 'delete',
                },
              ],
              now,
            ).pipe(Effect.map(applied => applied.has(input.clientMutationId))),
          conflict: () => new ListConflict({ id: input.id }),
        })
      })

    const reorder = (
      viewer: ListViewer,
      input: ListReorderInput,
      now: string = new Date().toISOString(),
    ): Effect.Effect<ReadonlyArray<ListItem>, ListServiceError> =>
      Effect.gen(function* () {
        const listKey = `${input.clientMutationId}:list`
        const prior = yield* appliedMutations(viewer, [listKey])
        if (prior.has(listKey))
          return yield* listItems(viewer, { listId: input.listId })

        yield* casUpdate({
          read: loadList(viewer, input.listId),
          // The list's own version bumps on every reorder (domain-model §3.8),
          // so a concurrently edited list row cannot claim the old ordering.
          plan: currentList =>
            Effect.succeed(
              new List({
                ...currentList,
                version: currentList.version + 1,
                updatedAt: now,
              }),
            ),
          write: (currentList, nextList) =>
            Effect.gen(function* () {
              // The items are read against the same fresh list version the CAS
              // guards, and the whole permutation lands as one batch.
              const visible = yield* items
                .listByList({
                  listId: input.listId,
                  householdId: viewer.householdId,
                  userId: viewer.userId,
                })
                .pipe(Effect.orDie)
              const all = yield* items
                .listAllForList({
                  listId: input.listId,
                  householdId: viewer.householdId,
                })
                .pipe(Effect.orDie)
              const visibleIds = new Set(visible.map(item => item.id))
              const byId = new Map(all.map(item => [item.id, item]))
              for (const id of input.itemIds) {
                if (!visibleIds.has(id)) {
                  return yield* invalid(
                    'itemIds',
                    'every reordered item must belong to this list',
                  )
                }
              }
              // Unknown or duplicate ids would silently drop rows; require a
              // complete, unique permutation of the visible items.
              if (
                new Set(input.itemIds).size !== input.itemIds.length ||
                input.itemIds.length !== visible.length
              ) {
                return yield* invalid(
                  'itemIds',
                  'itemIds must contain every visible item exactly once',
                )
              }
              const ordered = [
                ...input.itemIds.map(id => byId.get(id)!),
                ...visible
                  .filter(item => !input.itemIds.includes(item.id))
                  .map(item => byId.get(item.id)!),
              ]
              const hidden = all.filter(
                item => !ordered.some(entry => entry.id === item.id),
              )
              const final = [...ordered, ...hidden]

              const groups: Array<EntityGroup> = []
              final.forEach((item, index) => {
                const order = index + 1
                const visibility =
                  currentList.visibility === 'private'
                    ? 'private'
                    : item.visibility
                if (item.order === order && item.visibility === visibility)
                  return
                groups.push({
                  state: itemState(
                    new ListItem({
                      ...item,
                      order,
                      visibility,
                      version: item.version + 1,
                      updatedAt: now,
                    }),
                    viewer.userId,
                  ),
                  expectedVersion: item.version,
                  clientMutationId: `${input.clientMutationId}:item:${item.id}`,
                })
              })
              groups.push({
                state: listState(nextList, viewer.userId),
                expectedVersion: currentList.version,
                clientMutationId: listKey,
              })

              const applied = yield* commitGroups(viewer, groups, now)
              return applied.has(listKey)
            }),
          conflict: () => new ListConflict({ id: input.listId }),
        })

        return yield* listItems(viewer, { listId: input.listId })
      })

    return {
      create,
      get,
      update,
      remove,
      list,
      listItems,
      createItem,
      appendItems,
      updateItem,
      setItemChecked,
      deleteItem,
      reorder,
    } as const
  }),
}) {}

export const ListServiceLive = Layer.effect(ListService, ListService.make).pipe(
  Layer.provide(ListRepoLive),
  Layer.provide(PlanningListItemRepoLive),
  Layer.provide(TagRepoLive),
  Layer.provide(SyncRepoLive),
)
