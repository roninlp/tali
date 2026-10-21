import { Context, Effect, Layer, Option, Schema } from "effect"
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
  type SyncEntityType,
  type TagId,
  type UserId,
  uuidV7,
  type Visibility
} from "@tali/domain"
import {
  ListRepo,
  ListRepoLive,
  type SyncEntityState,
  SyncRepo,
  SyncRepoLive,
  TagRepo,
  TagRepoLive,
  PlanningListItemRepo,
  PlanningListItemRepoLive
} from "@tali/sql"
import { loadAssignableTags } from "./tag-guard.js"

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

const MAX_CAS_ATTEMPTS = 3

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
    now?: string
  ) => Effect.Effect<List, ListServiceError>
  readonly get: (viewer: ListViewer, id: List["id"]) => Effect.Effect<List, ListServiceError>
  readonly update: (
    viewer: ListViewer,
    input: ListUpdateInput,
    now?: string
  ) => Effect.Effect<List, ListServiceError>
  readonly remove: (
    viewer: ListViewer,
    input: ListMutationInput,
    now?: string
  ) => Effect.Effect<List, ListServiceError>
  readonly list: (viewer: ListViewer) => Effect.Effect<ReadonlyArray<List>, ListServiceError>
  readonly listItems: (
    viewer: ListViewer,
    input: ListItemsQuery
  ) => Effect.Effect<ReadonlyArray<ListItem>, ListServiceError>
  readonly createItem: (
    viewer: ListViewer,
    input: ListItemCreateInput,
    now?: string
  ) => Effect.Effect<ListItem, ListServiceError>
  readonly appendItems: (
    viewer: ListViewer,
    input: ListItemsAppendInput,
    now?: string
  ) => Effect.Effect<ReadonlyArray<ListItem>, ListServiceError>
  readonly updateItem: (
    viewer: ListViewer,
    input: ListItemUpdateInput,
    now?: string
  ) => Effect.Effect<ListItem, ListServiceError>
  readonly setItemChecked: (
    viewer: ListViewer,
    input: ListItemCheckInput,
    now?: string
  ) => Effect.Effect<ListItem, ListServiceError>
  readonly deleteItem: (
    viewer: ListViewer,
    input: ListItemMutationInput,
    now?: string
  ) => Effect.Effect<ListItem, ListServiceError>
  readonly reorder: (
    viewer: ListViewer,
    input: ListReorderInput,
    now?: string
  ) => Effect.Effect<ReadonlyArray<ListItem>, ListServiceError>
}

const invalid = (field: string, message: string): Effect.Effect<never, ListValidationError> =>
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
  ordering: item.order
})

interface EntityGroup {
  readonly state: SyncEntityState
  readonly expectedVersion: number | null
  readonly clientMutationId: string
  readonly op?: "upsert" | "delete"
  readonly tagChanges?: {
    readonly previous: ReadonlyArray<TagId>
    readonly next: ReadonlyArray<TagId>
  }
}

export class ListService extends Context.Service<ListService>()("ListService", {
  make: Effect.gen(function*() {
    const lists = yield* ListRepo
    const items = yield* PlanningListItemRepo
    const tags = yield* TagRepo
    const sync = yield* SyncRepo

    const definition = (entityType: SyncEntityType) => {
      const def = sync.definition(entityType)
      if (def === undefined) {
        throw new Error(`sync entity type is not registered: ${entityType}`)
      }
      return def
    }

    /**
     * The list aggregate + the server-stamped last writer (#39). The List
     * model does not carry attribution, so it is added after the same schema
     * boundary the sync push uses; the registry writes/reads the column.
     */
    const listState = (list: List, writerId: string): SyncEntityState => {
      const def = definition("list")
      const data = def.validate(
        { ...list } as Record<string, unknown>,
        { version: list.version, updatedAt: list.updatedAt, deletedAt: list.deletedAt }
      )
      return {
        entityType: "list",
        entityId: list.id,
        householdId: list.householdId,
        ownerId: list.ownerId,
        visibility: list.visibility,
        version: list.version,
        updatedAt: list.updatedAt,
        deletedAt: list.deletedAt,
        data: { ...data, lastWriterId: writerId }
      }
    }

    const itemState = (item: ListItem, writerId: string): SyncEntityState => {
      const def = definition("listItem")
      return {
        entityType: "listItem",
        entityId: item.id,
        householdId: item.householdId,
        ownerId: item.ownerId,
        visibility: item.visibility,
        version: item.version,
        updatedAt: item.updatedAt,
        deletedAt: item.deletedAt,
        data: {
          ...def.validate(itemWire(item), {
            version: item.version,
            updatedAt: item.updatedAt,
            deletedAt: item.deletedAt
          }),
          lastWriterId: writerId
        }
      }
    }

    const appliedMutations = (viewer: ListViewer, ids: ReadonlyArray<string>) =>
      sync
        .findApplied({ householdId: viewer.householdId, clientMutationIds: ids })
        .pipe(Effect.orDie)

    const reusedMutationIdError = (id: string) =>
      invalid("clientMutationId", "this mutation id was already applied to a different change")

    /**
     * One batch over N entity groups. Groups already recorded for this
     * mutation id are skipped, so a replay after a lost response cannot write
     * twice; a group whose id belongs to another row is rejected.
     */
    const commitGroups = (
      viewer: ListViewer,
      groups: ReadonlyArray<EntityGroup>,
      now: string
    ) =>
      Effect.gen(function*() {
        const prior = yield* appliedMutations(
          viewer,
          groups.map((group) => group.clientMutationId)
        )
        for (const group of groups) {
          const applied = prior.get(group.clientMutationId)
          if (
            applied !== undefined &&
            (applied.entityType !== group.state.entityType ||
              applied.entityId !== group.state.entityId)
          ) {
            return yield* reusedMutationIdError(group.state.entityId)
          }
        }

        const statements = groups
          .filter((group) => !prior.has(group.clientMutationId))
          .flatMap((group) => {
            const batch = [
              sync.writeEntity({
                state: group.state,
                expectedVersion: group.expectedVersion
              }),
              sync.appendFeed({
                householdId: viewer.householdId,
                entityType: group.state.entityType,
                entityId: group.state.entityId,
                op: group.op ?? "upsert",
                version: group.state.version,
                updatedAt: group.state.updatedAt,
                ownerId: group.state.ownerId,
                visibility: group.state.visibility
              }),
              sync.recordApplied({
                clientMutationId: group.clientMutationId,
                householdId: viewer.householdId,
                entityType: group.state.entityType,
                entityId: group.state.entityId,
                version: group.state.version,
                createdAt: now
              })
            ]
            if (
              group.tagChanges !== undefined &&
              !sameTags(group.tagChanges.previous, group.tagChanges.next)
            ) {
              batch.push(
                items.detachTagsIfVersion({
                  itemId: group.state.entityId as ListItem["id"],
                  version: group.state.version,
                  updatedAt: group.state.updatedAt
                }),
                ...group.tagChanges.next.map((tagId) =>
                  items.attachTagIfVersion({
                    itemId: group.state.entityId as ListItem["id"],
                    tagId,
                    householdId: viewer.householdId,
                    createdAt: now,
                    version: group.state.version,
                    updatedAt: group.state.updatedAt
                  })
                )
              )
            }
            return batch
          })

        if (statements.length > 0) yield* sync.commit(statements).pipe(Effect.orDie)
        return yield* appliedMutations(
          viewer,
          groups.map((group) => group.clientMutationId)
        )
      })

    const loadList = (
      viewer: ListViewer,
      id: List["id"]
    ): Effect.Effect<List, ListServiceError> =>
      Effect.gen(function*() {
        const found = yield* lists.findById(id).pipe(Effect.orDie)
        if (Option.isNone(found) || found.value.deletedAt !== null) {
          return yield* Effect.fail(new ListNotFound({ id }))
        }
        const list = found.value
        if (list.householdId !== viewer.householdId) {
          return yield* Effect.fail(new ListForbidden({ id, reason: "household" }))
        }
        if (list.visibility === "private" && list.ownerId !== viewer.userId) {
          return yield* Effect.fail(new ListForbidden({ id, reason: "private" }))
        }
        return list
      })

    const loadItem = (
      viewer: ListViewer,
      id: ListItem["id"]
    ): Effect.Effect<ListItem, ListServiceError> =>
      Effect.gen(function*() {
        const found = yield* items.findById(id).pipe(Effect.orDie)
        if (Option.isNone(found) || found.value.deletedAt !== null) {
          return yield* Effect.fail(new ListEntryNotFound({ id }))
        }
        const item = found.value
        if (item.householdId !== viewer.householdId) {
          return yield* Effect.fail(new ListForbidden({ id, reason: "household" }))
        }
        if (item.visibility === "private" && item.ownerId !== viewer.userId) {
          return yield* Effect.fail(new ListForbidden({ id, reason: "private" }))
        }
        // The parent list's visibility is a second gate: an item can never be
        // read through a private list owned by the other member.
        yield* loadList(viewer, item.listId)
        return item
      })

    const requireTags = (
      viewer: ListViewer,
      tagIds: ReadonlyArray<TagId>
    ): Effect.Effect<void, ListValidationError> =>
      loadAssignableTags(tags, viewer, tagIds).pipe(
        Effect.mapError((issue) => new ListValidationError({ issues: [issue] })),
        Effect.asVoid
      )

    /** Replay guard for one list: same mutation id + same row ⇒ stored row. */
    const replayList = (
      viewer: ListViewer,
      clientMutationId: string,
      expectedId?: List["id"]
    ): Effect.Effect<Option.Option<List>, ListServiceError> =>
      Effect.gen(function*() {
        const prior = yield* appliedMutations(viewer, [clientMutationId])
        const row = prior.get(clientMutationId)
        if (row === undefined) return Option.none()
        if (row.entityType !== "list" || (expectedId !== undefined && row.entityId !== expectedId)) {
          return yield* reusedMutationIdError(expectedId ?? row.entityId)
        }
        return yield* Effect.option(loadList(viewer, row.entityId as List["id"]))
      })

    const replayItem = (
      viewer: ListViewer,
      clientMutationId: string,
      expectedId?: ListItem["id"]
    ): Effect.Effect<Option.Option<ListItem>, ListServiceError> =>
      Effect.gen(function*() {
        const prior = yield* appliedMutations(viewer, [clientMutationId])
        const row = prior.get(clientMutationId)
        if (row === undefined) return Option.none()
        if (
          row.entityType !== "listItem" ||
          (expectedId !== undefined && row.entityId !== expectedId)
        ) {
          return yield* reusedMutationIdError(expectedId ?? row.entityId)
        }
        return yield* Effect.option(loadItem(viewer, row.entityId as ListItem["id"]))
      })

    const listItems = (
      viewer: ListViewer,
      input: ListItemsQuery
    ): Effect.Effect<ReadonlyArray<ListItem>, ListServiceError> =>
      Effect.gen(function*() {
        yield* loadList(viewer, input.listId)
        return yield* items
          .listByList({
            listId: input.listId,
            householdId: viewer.householdId,
            userId: viewer.userId
          })
          .pipe(Effect.orDie)
      })

    const nextOrder = (listId: List["id"], householdId: string) =>
      Effect.map(items.listAllForList({ listId, householdId }).pipe(Effect.orDie), (rows) =>
        rows.reduce((max, item) => Math.max(max, item.order), 0) + 1
      )

    // ── Lists ────────────────────────────────────────────────────────────

    const create = (
      viewer: ListViewer,
      input: ListCreateInput,
      now: string = new Date().toISOString()
    ): Effect.Effect<List, ListServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayList(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        const list = new List({
          id: (input.id ?? uuidV7()) as List["id"],
          type: "list",
          title: input.title.trim(),
          description: input.description ?? null,
          ownerId: viewer.userId,
          householdId: viewer.householdId,
          visibility: (input.visibility ?? "shared") as Visibility,
          color: input.color ?? null,
          icon: input.icon ?? null,
          sort: input.sort ?? "manual",
          checkedPlacement:
            input.checkedPlacement ?? viewer.defaultCheckedPlacement ?? "bottom",
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null
        })
        if (list.title === "") return yield* invalid("title", "a list needs a title")

        const applied = yield* commitGroups(
          viewer,
          [{
            state: listState(list, viewer.userId),
            expectedVersion: null,
            clientMutationId: input.clientMutationId
          }],
          now
        )
        if (!applied.has(input.clientMutationId)) {
          return yield* Effect.fail(new ListConflict({ id: list.id }))
        }
        return list
      })

    const get = (viewer: ListViewer, id: List["id"]): Effect.Effect<List, ListServiceError> =>
      loadList(viewer, id)

    const update = (
      viewer: ListViewer,
      input: ListUpdateInput,
      now: string = new Date().toISOString()
    ): Effect.Effect<List, ListServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayList(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* loadList(viewer, input.id)
          const patch: ListPatch = input.patch
          if (patch.title !== undefined && patch.title.trim() === "") {
            return yield* invalid("title", "a list needs a title")
          }
          // Only the creator can flip a shared list to private; the other
          // member must not be able to lock the owner out.
          if (patch.visibility === "private" && current.ownerId !== viewer.userId) {
            return yield* invalid("visibility", "only the list owner can make it private")
          }
          const next = new List({
            ...current,
            title: patch.title?.trim() ?? current.title,
            description: patch.description !== undefined
              ? patch.description
              : current.description,
            color: patch.color !== undefined ? patch.color : current.color,
            icon: patch.icon !== undefined ? patch.icon : current.icon,
            sort: patch.sort ?? current.sort,
            checkedPlacement: patch.checkedPlacement ?? current.checkedPlacement,
            visibility: patch.visibility ?? current.visibility,
            version: current.version + 1,
            updatedAt: now
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
            return current
          }
          const applied = yield* commitGroups(
            viewer,
            [{
              state: listState(next, viewer.userId),
              expectedVersion: current.version,
              clientMutationId: input.clientMutationId
            }],
            now
          )
          if (applied.has(input.clientMutationId)) return next
        }
        return yield* Effect.fail(new ListConflict({ id: input.id }))
      })

    const remove = (
      viewer: ListViewer,
      input: ListMutationInput,
      now: string = new Date().toISOString()
    ): Effect.Effect<List, ListServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayList(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* loadList(viewer, input.id)
          // Cascade the soft delete to every live item, including a spouse's
          // private rows, so nothing outlives the list in their mirror.
          const children = yield* items
            .listAllForList({ listId: current.id, householdId: viewer.householdId })
            .pipe(Effect.orDie)
          const listId = `${input.clientMutationId}:list`
          const groups: Array<EntityGroup> = [
            {
              state: listState(
                new List({
                  ...current,
                  version: current.version + 1,
                  updatedAt: now,
                  deletedAt: now
                }),
                viewer.userId
              ),
              expectedVersion: current.version,
              clientMutationId: listId,
              op: "delete"
            },
            ...children.map((item) => ({
              state: itemState(
                new ListItem({
                  ...item,
                  version: item.version + 1,
                  updatedAt: now,
                  deletedAt: now
                }),
                viewer.userId
              ),
              expectedVersion: item.version,
              clientMutationId: `${input.clientMutationId}:item:${item.id}`,
              op: "delete" as const
            }))
          ]
          const applied = yield* commitGroups(viewer, groups, now)
          if (applied.has(listId)) {
            return new List({ ...current, version: current.version + 1, updatedAt: now, deletedAt: now })
          }
        }
        return yield* Effect.fail(new ListConflict({ id: input.id }))
      })

    const list = (viewer: ListViewer): Effect.Effect<ReadonlyArray<List>, ListServiceError> =>
      lists
        .listVisible({ householdId: viewer.householdId, userId: viewer.userId })
        .pipe(Effect.orDie)

    // ── List items ───────────────────────────────────────────────────────

    const createItem = (
      viewer: ListViewer,
      input: ListItemCreateInput,
      now: string = new Date().toISOString()
    ): Effect.Effect<ListItem, ListServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayItem(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value
        const parent = yield* loadList(viewer, input.listId)
        yield* requireTags(viewer, input.tagIds ?? [])
        const name = input.name.trim()
        if (name === "") return yield* invalid("name", "an item needs a name")

        const item = new ListItem({
          id: (input.id ?? uuidV7()) as ListItem["id"],
          type: "listItem",
          listId: parent.id,
          name,
          done: false,
          order: input.order ?? (yield* nextOrder(parent.id, viewer.householdId)),
          checkedAt: null,
          tagIds: input.tagIds ?? [],
          ownerId: viewer.userId,
          householdId: viewer.householdId,
          visibility: parent.visibility === "private"
            ? "private"
            : (input.visibility ?? "shared") as Visibility,
          color: input.color ?? null,
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null
        })
        const applied = yield* commitGroups(
          viewer,
          [{
            state: itemState(item, viewer.userId),
            expectedVersion: null,
            clientMutationId: input.clientMutationId,
            tagChanges: { previous: [], next: item.tagIds }
          }],
          now
        )
        if (!applied.has(input.clientMutationId)) {
          return yield* Effect.fail(new ListConflict({ id: item.id }))
        }
        return item
      })

    const appendItems = (
      viewer: ListViewer,
      input: ListItemsAppendInput,
      now: string = new Date().toISOString()
    ): Effect.Effect<ReadonlyArray<ListItem>, ListServiceError> =>
      Effect.gen(function*() {
        const parent = yield* loadList(viewer, input.listId)
        if (input.items.length === 0) {
          return yield* invalid("items", "append at least one item")
        }
        for (const entry of input.items) {
          if (entry.name.trim() === "") {
            return yield* invalid("name", "an item needs a name")
          }
        }
        for (const entry of input.items) {
          yield* requireTags(viewer, entry.tagIds ?? [])
        }

        // A lost response replays the same batch key. Child keys are positional
        // so a retry still recognises a batch whose ids the server minted.
        const replayKeys = input.items.map(
          (_entry, index) => `${input.clientMutationId}:item:${index}`
        )
        const prior = yield* appliedMutations(viewer, replayKeys)
        if (prior.size > 0) return yield* listItems(viewer, { listId: input.listId })

        const baseOrder = yield* nextOrder(parent.id, viewer.householdId)
        const created = input.items.map((entry, index) =>
          new ListItem({
            id: (entry.id ?? uuidV7()) as ListItem["id"],
            type: "listItem",
            listId: parent.id,
            name: entry.name.trim(),
            done: false,
            order: baseOrder + index,
            checkedAt: null,
            tagIds: entry.tagIds ?? [],
            ownerId: viewer.userId,
            householdId: viewer.householdId,
            visibility: parent.visibility === "private"
              ? "private"
              : (entry.visibility ?? "shared") as Visibility,
            color: entry.color ?? null,
            createdAt: now,
            updatedAt: now,
            version: 1,
            deletedAt: null
          })
        )
        yield* commitGroups(
          viewer,
          created.map((item, index) => ({
            state: itemState(item, viewer.userId),
            expectedVersion: null,
            clientMutationId: `${input.clientMutationId}:item:${index}`,
            tagChanges: { previous: [], next: item.tagIds }
          })),
          now
        )
        return yield* listItems(viewer, { listId: input.listId })
      })

    const updateItem = (
      viewer: ListViewer,
      input: ListItemUpdateInput,
      now: string = new Date().toISOString()
    ): Effect.Effect<ListItem, ListServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayItem(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* loadItem(viewer, input.id)
          const patch: ListItemPatch = input.patch
          if (patch.name !== undefined && patch.name.trim() === "") {
            return yield* invalid("name", "an item needs a name")
          }
          if (patch.tagIds !== undefined) yield* requireTags(viewer, patch.tagIds)
          if (patch.visibility === "private" && current.ownerId !== viewer.userId) {
            return yield* invalid("visibility", "only the item owner can make it private")
          }
          const next = new ListItem({
            ...current,
            name: patch.name?.trim() ?? current.name,
            order: patch.order ?? current.order,
            color: patch.color !== undefined ? patch.color : current.color,
            tagIds: patch.tagIds ?? current.tagIds,
            visibility: patch.visibility ?? current.visibility,
            version: current.version + 1,
            updatedAt: now
          })
          if (
            next.name === current.name &&
            next.order === current.order &&
            next.color === current.color &&
            next.visibility === current.visibility &&
            sameTags(next.tagIds, current.tagIds)
          ) {
            return current
          }
          const applied = yield* commitGroups(
            viewer,
            [{
              state: itemState(next, viewer.userId),
              expectedVersion: current.version,
              clientMutationId: input.clientMutationId,
              tagChanges: { previous: current.tagIds, next: next.tagIds }
            }],
            now
          )
          if (applied.has(input.clientMutationId)) return next
        }
        return yield* Effect.fail(new ListConflict({ id: input.id }))
      })

    const setItemChecked = (
      viewer: ListViewer,
      input: ListItemCheckInput,
      now: string = new Date().toISOString()
    ): Effect.Effect<ListItem, ListServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayItem(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* loadItem(viewer, input.id)
          // Idempotent: re-checking a checked item (or unchecking an unchecked
          // one) writes nothing and does not mint a version.
          if (current.done === input.checked) return current
          const next = new ListItem({
            ...current,
            done: input.checked,
            checkedAt: input.checked ? now : null,
            version: current.version + 1,
            updatedAt: now
          })
          const applied = yield* commitGroups(
            viewer,
            [{
              state: itemState(next, viewer.userId),
              expectedVersion: current.version,
              clientMutationId: input.clientMutationId
            }],
            now
          )
          if (applied.has(input.clientMutationId)) return next
        }
        return yield* Effect.fail(new ListConflict({ id: input.id }))
      })

    const deleteItem = (
      viewer: ListViewer,
      input: ListItemMutationInput,
      now: string = new Date().toISOString()
    ): Effect.Effect<ListItem, ListServiceError> =>
      Effect.gen(function*() {
        const replayed = yield* replayItem(viewer, input.clientMutationId, input.id)
        if (Option.isSome(replayed)) return replayed.value

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const current = yield* loadItem(viewer, input.id)
          const next = new ListItem({
            ...current,
            version: current.version + 1,
            updatedAt: now,
            deletedAt: now
          })
          const applied = yield* commitGroups(
            viewer,
            [{
              state: itemState(next, viewer.userId),
              expectedVersion: current.version,
              clientMutationId: input.clientMutationId,
              op: "delete"
            }],
            now
          )
          if (applied.has(input.clientMutationId)) return next
        }
        return yield* Effect.fail(new ListConflict({ id: input.id }))
      })

    const reorder = (
      viewer: ListViewer,
      input: ListReorderInput,
      now: string = new Date().toISOString()
    ): Effect.Effect<ReadonlyArray<ListItem>, ListServiceError> =>
      Effect.gen(function*() {
        const listKey = `${input.clientMutationId}:list`
        const prior = yield* appliedMutations(viewer, [listKey])
        if (prior.has(listKey)) return yield* listItems(viewer, { listId: input.listId })

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const currentList = yield* loadList(viewer, input.listId)
          const visible = yield* items
            .listByList({
              listId: input.listId,
              householdId: viewer.householdId,
              userId: viewer.userId
            })
            .pipe(Effect.orDie)
          const all = yield* items
            .listAllForList({ listId: input.listId, householdId: viewer.householdId })
            .pipe(Effect.orDie)
          const visibleIds = new Set(visible.map((item) => item.id))
          const byId = new Map(all.map((item) => [item.id, item]))
          for (const id of input.itemIds) {
            if (!visibleIds.has(id)) {
              return yield* invalid("itemIds", "every reordered item must belong to this list")
            }
          }
          // Unknown or duplicate ids would silently drop rows; require a
          // complete, unique permutation of the visible items.
          if (
            new Set(input.itemIds).size !== input.itemIds.length ||
            input.itemIds.length !== visible.length
          ) {
            return yield* invalid("itemIds", "itemIds must contain every visible item exactly once")
          }
          const ordered = [
            ...input.itemIds.map((id) => byId.get(id)!),
            ...visible
              .filter((item) => !input.itemIds.includes(item.id))
              .map((item) => byId.get(item.id)!)
          ]
          const hidden = all.filter(
            (item) => !ordered.some((entry) => entry.id === item.id)
          )
          const final = [...ordered, ...hidden]

          const groups: Array<EntityGroup> = []
          final.forEach((item, index) => {
            const order = index + 1
            if (item.order === order) return
            groups.push({
              state: itemState(
                new ListItem({
                  ...item,
                  order,
                  version: item.version + 1,
                  updatedAt: now
                }),
                viewer.userId
              ),
              expectedVersion: item.version,
              clientMutationId: `${input.clientMutationId}:item:${item.id}`
            })
          })
          // The list's version bumps once per reorder (domain-model §3.8), so a
          // concurrently edited list row cannot claim the old ordering.
          groups.push({
            state: listState(
              new List({
                ...currentList,
                version: currentList.version + 1,
                updatedAt: now
              }),
              viewer.userId
            ),
            expectedVersion: currentList.version,
            clientMutationId: listKey
          })

          const applied = yield* commitGroups(viewer, groups, now)
          if (applied.has(listKey)) {
            return yield* listItems(viewer, { listId: input.listId })
          }
        }
        return yield* Effect.fail(new ListConflict({ id: input.listId }))
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
      reorder
    } as const
  })
}) {}

export const ListServiceLive = Layer.effect(ListService, ListService.make).pipe(
  Layer.provide(ListRepoLive),
  Layer.provide(PlanningListItemRepoLive),
  Layer.provide(TagRepoLive),
  Layer.provide(SyncRepoLive)
)
