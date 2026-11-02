import { Array, Clock, Duration, Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { uuidV7 } from '@tali/domain'
import { ListId } from '@tali/domain'

import {
  createListInMirror,
  createListItemInMirror,
  deleteListInMirror,
  deleteListItemInMirror,
  readListItems,
  reorderListItemsInMirror,
  setListItemCheckedInMirror,
  uncheckListItemInMirror,
  updateListInMirror,
  writeListSettingIfLatest,
} from '../lib/list-writes'
import {
  COLOR_CHOICES,
  CheckedPlacement,
  ICON_CHOICES,
  ListRow,
  ListSort,
  ListVisibility,
  droppedOrder,
  findListRow,
  listItemsFor,
  manualOrder,
  movedOrder,
  nextItemOrder,
} from '../lists-model'
import type { MirrorSnapshot } from '../mirror'
import type { CheckedItemPlacement, DisplayFields } from '../preferences-model'
import { LocalStoreResource } from '../sync/local-store'
import type { LocalStoreService } from '../sync/local-store'
import { listDetailView } from './list-view'
import { listsIndexView } from './lists-view'

/**
 * The `/lists` index and `/lists/[id]` detail Submodel, ported from
 * `apps/web/src/components/lists/*` (ticket #39; FR-LIST-01/02/03).
 *
 * Both screens read the same mirror snapshot: the Model keeps their drafts,
 * busy flags, detail error, check toast and drag state, while the rows and the
 * pending keys arrive as update/view inputs. Every write goes through the
 * local store first (mirror row + outbox entry in one transaction), then the
 * root asks sync to re-read the mirror. No list write uses RPC.
 */

// MODEL

export const ToastItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})
export type ToastItem = typeof ToastItem.Type

export const DeleteScope = Schema.Literals(['index', 'detail'])
export type DeleteScope = typeof DeleteScope.Type

export const MoveDirection = Schema.Literals(['up', 'down'])
export type MoveDirection = typeof MoveDirection.Type

export const Model = Schema.Struct({
  indexTitle: Schema.String,
  indexColor: Schema.String,
  indexIcon: Schema.String,
  indexVisibility: ListVisibility,
  isCreating: Schema.Boolean,
  maybeIndexError: Schema.Option(Schema.String),
  maybeListId: Schema.Option(ListId),
  maybeTitleDraft: Schema.Option(Schema.String),
  maybeSortDraft: Schema.Option(ListSort),
  maybePlacementDraft: Schema.Option(CheckedPlacement),
  maybeVisibilityDraft: Schema.Option(ListVisibility),
  isRenaming: Schema.Boolean,
  settingsRevision: Schema.Int,
  itemDraft: Schema.String,
  isAddingItem: Schema.Boolean,
  isDeletingList: Schema.Boolean,
  isDetailLoading: Schema.Boolean,
  maybeDetailError: Schema.Option(Schema.String),
  maybeToast: Schema.Option(ToastItem),
  toastGeneration: Schema.Int,
  maybeDraggingId: Schema.Option(Schema.String),
  maybeDragOverId: Schema.Option(Schema.String),
  announcement: Schema.String,
})
export type Model = typeof Model.Type

export const initialModel = (): Model =>
  Model.make({
    indexTitle: '',
    indexColor: COLOR_CHOICES[0] ?? '',
    indexIcon: ICON_CHOICES[0] ?? '',
    indexVisibility: 'shared',
    isCreating: false,
    maybeIndexError: Option.none(),
    maybeListId: Option.none(),
    maybeTitleDraft: Option.none(),
    maybeSortDraft: Option.none(),
    maybePlacementDraft: Option.none(),
    maybeVisibilityDraft: Option.none(),
    isRenaming: false,
    settingsRevision: 0,
    itemDraft: '',
    isAddingItem: false,
    isDeletingList: false,
    isDetailLoading: false,
    maybeDetailError: Option.none(),
    maybeToast: Option.none(),
    toastGeneration: 0,
    maybeDraggingId: Option.none(),
    maybeDragOverId: Option.none(),
    announcement: '',
  })

/** Everything the screens read from their siblings on each dispatch. */
export type Inputs = Readonly<{
  display: DisplayFields
  checkedItemPlacement: CheckedItemPlacement
  isStoreReady: boolean
  isOnline: boolean
  pending: number
  mirror: MirrorSnapshot
  pendingKeys: ReadonlyArray<string>
  maybeUserId: Option.Option<string>
}>

export type ViewInputs = Inputs

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedIndexTitle: { value: Schema.String },
  SelectedIndexColor: { color: Schema.String },
  SelectedIndexIcon: { icon: Schema.String },
  ToggledIndexVisibility: { isPrivate: Schema.Boolean },
  SubmittedCreateList: {},
  CompletedCreateList: { listId: Schema.String, title: Schema.String },
  FailedCreateList: { message: Schema.String },
  ClickedDeleteList: {
    listId: Schema.String,
    title: Schema.String,
    scope: DeleteScope,
  },
  CompletedConfirmListDelete: {
    listId: Schema.String,
    isConfirmed: Schema.Boolean,
  },
  CompletedDeleteList: { listId: Schema.String },
  FailedDeleteList: { message: Schema.String },

  UpdatedTitleDraft: { value: Schema.String },
  BlurredTitleInput: {},
  SubmittedRenameList: {},
  CompletedRenameList: { listId: Schema.String, title: Schema.String },
  FailedRenameList: { message: Schema.String },
  SelectedListSort: { listId: Schema.String, sort: ListSort },
  CompletedSetListSort: { listId: Schema.String },
  FailedSetListSort: { message: Schema.String },
  SelectedCheckedPlacement: {
    listId: Schema.String,
    placement: CheckedPlacement,
  },
  CompletedSetCheckedPlacement: { listId: Schema.String },
  FailedSetCheckedPlacement: { message: Schema.String },
  SelectedListVisibility: {
    listId: Schema.String,
    visibility: ListVisibility,
  },
  CompletedSetListVisibility: { listId: Schema.String },
  FailedSetListVisibility: { message: Schema.String },
  UpdatedItemDraft: { value: Schema.String },
  SubmittedAddItem: {},
  CompletedCreateListItem: {
    listId: Schema.String,
    itemId: Schema.String,
    name: Schema.String,
  },
  FailedCreateListItem: { message: Schema.String },
  ClickedToggleItem: { itemId: Schema.String },
  CompletedSetListItemChecked: {
    itemId: Schema.String,
    name: Schema.String,
    checked: Schema.Boolean,
  },
  FailedSetListItemChecked: { message: Schema.String },
  ClickedUndoChecked: {},
  CompletedUncheckListItem: { itemId: Schema.String, name: Schema.String },
  FailedUncheckListItem: { message: Schema.String },
  CompletedWaitBeforeDismissToast: {
    itemId: Schema.String,
    generation: Schema.Int,
  },
  ClickedDeleteItem: { itemId: Schema.String, name: Schema.String },
  CompletedDeleteListItem: { itemId: Schema.String, name: Schema.String },
  FailedDeleteListItem: { message: Schema.String },
  ClickedMoveItem: { itemId: Schema.String, direction: MoveDirection },
  CompletedReorderListItems: {},
  FailedReorderListItems: { message: Schema.String },
  StartedDraggingItem: { itemId: Schema.String },
  EnteredDragTarget: { itemId: Schema.String },
  LeftDragTarget: { itemId: Schema.String },
  DroppedOnItem: { itemId: Schema.String },
  EndedDragItem: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  WroteLocalData: {},
  CreatedList: { listId: Schema.String },
  DeletedList: { listId: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

const storeFailureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'ذخیره در حافظه‌ی محلی ناموفق بود'

const currentIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

const deleteQuestion = (scope: DeleteScope, title: string): string =>
  scope === 'index'
    ? `فهرست «${title}» حذف شود؟ موارد آن هم از نمای شما پنهان می‌شوند.`
    : `فهرست «${title}» حذف شود؟`

export const CreateList = Command.define('CreateList', {
  args: {
    title: Schema.String,
    color: Schema.String,
    icon: Schema.String,
    sort: ListSort,
    checkedPlacement: CheckedPlacement,
    visibility: ListVisibility,
  },
  messages: [Message.CompletedCreateList, Message.FailedCreateList],
  execute: draft =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* Clock.currentTimeMillis
      const listId = uuidV7(now)
      const instant = new Date(now).toISOString()

      yield* Effect.tryPromise({
        try: () => createListInMirror(store, draft, listId, instant),
        catch: storeFailureMessage,
      })

      return Message.CompletedCreateList({ listId, title: draft.title })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCreateList({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

export const RenameList = Command.define('RenameList', {
  args: { listId: Schema.String, title: Schema.String },
  messages: [Message.CompletedRenameList, Message.FailedRenameList],
  execute: ({ listId, title }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () => updateListInMirror(store, listId, { title }, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedRenameList({ listId, title })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedRenameList({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

export const SetListSort = Command.define('SetListSort', {
  args: { listId: Schema.String, sort: ListSort, revision: Schema.Int },
  messages: [Message.CompletedSetListSort, Message.FailedSetListSort],
  execute: ({ listId, sort, revision }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () =>
          writeListSettingIfLatest(
            store,
            'sort',
            listId,
            revision,
            { sort },
            now,
          ),
        catch: storeFailureMessage,
      })

      return Message.CompletedSetListSort({ listId })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSetListSort({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

export const SetCheckedPlacement = Command.define('SetCheckedPlacement', {
  args: {
    listId: Schema.String,
    placement: CheckedPlacement,
    revision: Schema.Int,
  },
  messages: [
    Message.CompletedSetCheckedPlacement,
    Message.FailedSetCheckedPlacement,
  ],
  execute: ({ listId, placement, revision }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () =>
          writeListSettingIfLatest(
            store,
            'placement',
            listId,
            revision,
            { checkedPlacement: placement },
            now,
          ),
        catch: storeFailureMessage,
      })

      return Message.CompletedSetCheckedPlacement({ listId })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSetCheckedPlacement({
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const SetListVisibility = Command.define('SetListVisibility', {
  args: {
    listId: Schema.String,
    visibility: ListVisibility,
    revision: Schema.Int,
  },
  messages: [
    Message.CompletedSetListVisibility,
    Message.FailedSetListVisibility,
  ],
  execute: ({ listId, visibility, revision }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () =>
          writeListSettingIfLatest(
            store,
            'visibility',
            listId,
            revision,
            { visibility },
            now,
          ),
        catch: storeFailureMessage,
      })

      return Message.CompletedSetListVisibility({ listId })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSetListVisibility({
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const CreateListItem = Command.define('CreateListItem', {
  args: {
    listId: Schema.String,
    name: Schema.String,
    order: Schema.Int,
    visibility: ListVisibility,
  },
  messages: [Message.CompletedCreateListItem, Message.FailedCreateListItem],
  execute: ({ listId, name, order, visibility }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* Clock.currentTimeMillis
      const itemId = uuidV7(now)
      const instant = new Date(now).toISOString()

      yield* Effect.tryPromise({
        try: () =>
          createListItemInMirror(
            store,
            listId,
            { name, order, visibility },
            itemId,
            instant,
          ),
        catch: storeFailureMessage,
      })

      return Message.CompletedCreateListItem({ listId, itemId, name })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCreateListItem({
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const SetListItemChecked = Command.define('SetListItemChecked', {
  args: {
    itemId: Schema.String,
    name: Schema.String,
    checked: Schema.Boolean,
    wasDone: Schema.Boolean,
    maybeCheckedAt: Schema.Option(Schema.String),
  },
  messages: [
    Message.CompletedSetListItemChecked,
    Message.FailedSetListItemChecked,
  ],
  execute: ({ itemId, name, checked, wasDone, maybeCheckedAt }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () =>
          setListItemCheckedInMirror(
            store,
            {
              id: itemId,
              done: wasDone,
              checkedAt: Option.getOrNull(maybeCheckedAt),
            },
            checked,
            now,
          ),
        catch: storeFailureMessage,
      })

      return Message.CompletedSetListItemChecked({ itemId, name, checked })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSetListItemChecked({
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const UncheckListItem = Command.define('UncheckListItem', {
  args: { itemId: Schema.String, name: Schema.String },
  messages: [Message.CompletedUncheckListItem, Message.FailedUncheckListItem],
  execute: ({ itemId, name }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () => uncheckListItemInMirror(store, itemId, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedUncheckListItem({ itemId, name })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedUncheckListItem({
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const DeleteListItem = Command.define('DeleteListItem', {
  args: { itemId: Schema.String, name: Schema.String },
  messages: [Message.CompletedDeleteListItem, Message.FailedDeleteListItem],
  execute: ({ itemId, name }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () => deleteListItemInMirror(store, itemId, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedDeleteListItem({ itemId, name })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedDeleteListItem({
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const ReorderListItems = Command.define('ReorderListItems', {
  args: { listId: Schema.String, orderedIds: Schema.Array(Schema.String) },
  messages: [Message.CompletedReorderListItems, Message.FailedReorderListItems],
  execute: ({ orderedIds }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso
      const items = yield* Effect.tryPromise({
        try: () => readListItems(store),
        catch: storeFailureMessage,
      })

      yield* Effect.tryPromise({
        try: () => reorderListItemsInMirror(store, items, orderedIds, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedReorderListItems()
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedReorderListItems({
            message: storeFailureMessage(error),
          }),
        ),
      ),
    ),
})

export const DeleteList = Command.define('DeleteList', {
  args: {
    listId: Schema.String,
    itemIds: Schema.Array(Schema.String),
  },
  messages: [Message.CompletedDeleteList, Message.FailedDeleteList],
  execute: ({ listId, itemIds }) =>
    Effect.gen(function* () {
      const store = yield* LocalStoreResource.get
      const now = yield* currentIso

      yield* Effect.tryPromise({
        try: () => deleteListInMirror(store, listId, itemIds, now),
        catch: storeFailureMessage,
      })

      return Message.CompletedDeleteList({ listId })
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedDeleteList({ message: storeFailureMessage(error) }),
        ),
      ),
    ),
})

export const ConfirmListDelete = Command.define('ConfirmListDelete', {
  args: {
    listId: Schema.String,
    title: Schema.String,
    scope: DeleteScope,
  },
  messages: [Message.CompletedConfirmListDelete],
  execute: ({ listId, title, scope }) =>
    Effect.sync(() => {
      try {
        return window.confirm(deleteQuestion(scope, title))
      } catch {
        return false
      }
    }).pipe(
      Effect.map(isConfirmed =>
        Message.CompletedConfirmListDelete({ listId, isConfirmed }),
      ),
    ),
})

export const WaitBeforeDismissToast = Command.define('WaitBeforeDismissToast', {
  args: { itemId: Schema.String, generation: Schema.Int },
  messages: [Message.CompletedWaitBeforeDismissToast],
  execute: ({ itemId, generation }) =>
    Effect.sleep(Duration.seconds(6)).pipe(
      Effect.as(
        Message.CompletedWaitBeforeDismissToast({ itemId, generation }),
      ),
    ),
})

// INIT

export const init = (): Update.Return<Model, Message> => ({
  model: initialModel(),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  LocalStoreService
>

const currentList = (model: Model, inputs: Inputs): Option.Option<ListRow> =>
  Option.flatMap(model.maybeListId, listId =>
    findListRow(inputs.mirror.lists, listId),
  )

const withDetailError = (model: Model, message: string): UpdateReturn => ({
  model: modifyFields(model, {
    maybeDetailError: () => Option.some(message),
  }),
})

const withIndexError = (model: Model, message: string): UpdateReturn => ({
  model: modifyFields(model, {
    maybeIndexError: () => Option.some(message),
  }),
})

const moveItem = (
  model: Model,
  inputs: Inputs,
  itemId: string,
  direction: MoveDirection,
): UpdateReturn =>
  Option.match(currentList(model, inputs), {
    onNone: () => ({ model }),
    onSome: list => {
      if (list.sort !== 'manual') {
        return { model }
      }

      const items = listItemsFor(inputs.mirror.listItems, list.id)
      const orderedIds = movedOrder(items, itemId, direction === 'up' ? -1 : 1)
      const current = manualOrder(items)
      const unchanged = orderedIds.every((id, index) => id === current[index])

      return unchanged
        ? { model }
        : {
            model: modifyFields(model, {
              maybeDetailError: () => Option.none(),
            }),
            commands: [ReorderListItems({ listId: list.id, orderedIds })],
          }
    },
  })

const dropItem = (
  model: Model,
  inputs: Inputs,
  targetId: string,
): UpdateReturn =>
  Option.match(currentList(model, inputs), {
    onNone: () => ({ model }),
    onSome: list => {
      if (
        list.sort !== 'manual' ||
        Option.isNone(model.maybeDraggingId) ||
        Option.contains(model.maybeDraggingId, targetId)
      ) {
        return {
          model: modifyFields(model, {
            maybeDraggingId: () => Option.none(),
            maybeDragOverId: () => Option.none(),
          }),
        }
      }

      const draggedId = Option.getOrThrow(model.maybeDraggingId)
      const items = listItemsFor(inputs.mirror.listItems, list.id)
      const orderedIds = droppedOrder(items, draggedId, targetId)
      const current = manualOrder(items)
      const unchanged = orderedIds.every((id, index) => id === current[index])

      return unchanged
        ? {
            model: modifyFields(model, {
              maybeDraggingId: () => Option.none(),
              maybeDragOverId: () => Option.none(),
            }),
          }
        : {
            model: modifyFields(model, {
              maybeDraggingId: () => Option.none(),
              maybeDragOverId: () => Option.none(),
              maybeDetailError: () => Option.none(),
            }),
            commands: [ReorderListItems({ listId: list.id, orderedIds })],
          }
    },
  })

export const update = (
  model: Model,
  message: Message,
  inputs: Inputs,
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    UpdatedIndexTitle: ({ value }) => ({
      model: modifyFields(model, { indexTitle: () => value }),
    }),

    SelectedIndexColor: ({ color }) =>
      Array.contains(COLOR_CHOICES, color)
        ? { model: modifyFields(model, { indexColor: () => color }) }
        : { model },

    SelectedIndexIcon: ({ icon }) =>
      Array.contains(ICON_CHOICES, icon)
        ? { model: modifyFields(model, { indexIcon: () => icon }) }
        : { model },

    ToggledIndexVisibility: ({ isPrivate }) => ({
      model: modifyFields(model, {
        indexVisibility: () => (isPrivate ? 'private' : 'shared'),
      }),
    }),

    SubmittedCreateList: () => {
      const title = model.indexTitle.trim()

      if (!inputs.isStoreReady || model.isCreating || title === '') {
        return { model }
      }

      return {
        model: modifyFields(model, {
          isCreating: () => true,
          maybeIndexError: () => Option.none(),
        }),
        commands: [
          CreateList({
            title,
            color: model.indexColor,
            icon: model.indexIcon,
            sort: 'manual',
            checkedPlacement: inputs.checkedItemPlacement,
            visibility: model.indexVisibility,
          }),
        ],
      }
    },

    CompletedCreateList: ({ listId, title }) => ({
      model: modifyFields(model, {
        isCreating: () => false,
        indexTitle: () => '',
        maybeIndexError: () => Option.none(),
        announcement: () => `فهرست تازه: ${title}`,
      }),
      outMessage: OutMessage.CreatedList({ listId }),
    }),

    FailedCreateList: ({ message }) => {
      const failed = withIndexError(model, message)
      return {
        model: modifyFields(failed.model, { isCreating: () => false }),
      }
    },

    ClickedDeleteList: ({ listId, title, scope }) => ({
      model,
      commands: [ConfirmListDelete({ listId, title, scope })],
    }),

    CompletedConfirmListDelete: ({ listId, isConfirmed }) => {
      if (!isConfirmed) {
        return { model }
      }

      const itemIds = Array.map(
        listItemsFor(inputs.mirror.listItems, listId),
        item => item.id,
      )

      return {
        model: modifyFields(model, {
          isDeletingList: () => true,
          maybeIndexError: () => Option.none(),
          maybeDetailError: () => Option.none(),
        }),
        commands: [DeleteList({ listId, itemIds })],
      }
    },

    CompletedDeleteList: ({ listId }) => ({
      model: modifyFields(model, {
        isDeletingList: () => false,
        announcement: () => 'فهرست حذف شد',
      }),
      outMessage: OutMessage.DeletedList({ listId }),
    }),

    FailedDeleteList: ({ message }) => {
      const failed = withDetailError(model, message)
      return {
        model: modifyFields(failed.model, {
          isDeletingList: () => false,
          maybeIndexError: () => Option.some(message),
        }),
      }
    },

    UpdatedTitleDraft: ({ value }) => ({
      model: modifyFields(model, {
        maybeTitleDraft: () => Option.some(value),
      }),
    }),

    BlurredTitleInput: () =>
      Option.match(model.maybeTitleDraft, {
        onNone: () => ({ model }),
        onSome: value =>
          Option.match(currentList(model, inputs), {
            onNone: () => ({
              model: modifyFields(model, {
                maybeTitleDraft: () => Option.none(),
              }),
            }),
            onSome: list =>
              value.trim() === '' || value.trim() === list.title
                ? {
                    model: modifyFields(model, {
                      maybeTitleDraft: () => Option.none(),
                    }),
                  }
                : { model },
          }),
      }),

    SubmittedRenameList: () =>
      Option.match(currentList(model, inputs), {
        onNone: () => ({ model }),
        onSome: list => {
          const title = Option.getOrElse(
            model.maybeTitleDraft,
            () => list.title,
          ).trim()

          if (title === '' || title === list.title) {
            return {
              model: modifyFields(model, {
                maybeTitleDraft: () => Option.none(),
              }),
            }
          }

          if (model.isRenaming) {
            return { model }
          }

          return {
            model: modifyFields(model, {
              isRenaming: () => true,
              maybeDetailError: () => Option.none(),
            }),
            commands: [RenameList({ listId: list.id, title })],
          }
        },
      }),

    CompletedRenameList: ({ title }) => ({
      model: modifyFields(model, {
        isRenaming: () => false,
        maybeTitleDraft: () => Option.none(),
        maybeDetailError: () => Option.none(),
        announcement: () => `نام فهرست به‌روز شد: ${title}`,
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedRenameList: ({ message }) => {
      const failed = withDetailError(model, message)
      return {
        model: modifyFields(failed.model, { isRenaming: () => false }),
      }
    },

    SelectedListSort: ({ listId, sort }) => {
      const maybeList = findListRow(inputs.mirror.lists, listId)
      const effective = Option.match(model.maybeSortDraft, {
        onNone: () => Option.map(maybeList, list => list.sort),
        onSome: draft => Option.some(draft),
      })

      if (Option.contains(effective, sort)) {
        return { model }
      }

      const revision = model.settingsRevision + 1

      return {
        model: modifyFields(model, {
          maybeSortDraft: () => Option.some(sort),
          settingsRevision: () => revision,
          maybeDetailError: () => Option.none(),
        }),
        commands: [SetListSort({ listId, sort, revision })],
      }
    },

    CompletedSetListSort: () => ({
      model: modifyFields(model, {
        maybeDetailError: () => Option.none(),
        announcement: () => 'مرتب‌سازی فهرست به‌روز شد',
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedSetListSort: ({ message }) => {
      const failed = withDetailError(model, message)
      return {
        model: modifyFields(failed.model, {
          maybeSortDraft: () => Option.none(),
        }),
      }
    },

    SelectedCheckedPlacement: ({ listId, placement }) => {
      const maybeList = findListRow(inputs.mirror.lists, listId)
      const effective = Option.match(model.maybePlacementDraft, {
        onNone: () => Option.map(maybeList, list => list.checkedPlacement),
        onSome: draft => Option.some(draft),
      })

      if (Option.contains(effective, placement)) {
        return { model }
      }

      const revision = model.settingsRevision + 1

      return {
        model: modifyFields(model, {
          maybePlacementDraft: () => Option.some(placement),
          settingsRevision: () => revision,
          maybeDetailError: () => Option.none(),
        }),
        commands: [SetCheckedPlacement({ listId, placement, revision })],
      }
    },

    CompletedSetCheckedPlacement: () => ({
      model: modifyFields(model, {
        maybeDetailError: () => Option.none(),
        announcement: () => 'جای موارد تیک‌خورده به‌روز شد',
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedSetCheckedPlacement: ({ message }) => {
      const failed = withDetailError(model, message)
      return {
        model: modifyFields(failed.model, {
          maybePlacementDraft: () => Option.none(),
        }),
      }
    },

    SelectedListVisibility: ({ listId, visibility }) => {
      const maybeList = findListRow(inputs.mirror.lists, listId)
      const canChange = Option.exists(maybeList, list =>
        Option.exists(inputs.maybeUserId, userId => userId === list.ownerId),
      )
      const effective = Option.match(model.maybeVisibilityDraft, {
        onNone: () => Option.map(maybeList, list => list.visibility),
        onSome: draft => Option.some(draft),
      })

      if (!canChange || Option.contains(effective, visibility)) {
        return { model }
      }

      const revision = model.settingsRevision + 1

      return {
        model: modifyFields(model, {
          maybeVisibilityDraft: () => Option.some(visibility),
          settingsRevision: () => revision,
          maybeDetailError: () => Option.none(),
        }),
        commands: [SetListVisibility({ listId, visibility, revision })],
      }
    },

    CompletedSetListVisibility: () => ({
      model: modifyFields(model, {
        maybeDetailError: () => Option.none(),
        announcement: () => 'دسترسی فهرست به‌روز شد',
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedSetListVisibility: ({ message }) => {
      const failed = withDetailError(model, message)
      return {
        model: modifyFields(failed.model, {
          maybeVisibilityDraft: () => Option.none(),
        }),
      }
    },

    UpdatedItemDraft: ({ value }) => ({
      model: modifyFields(model, { itemDraft: () => value }),
    }),

    SubmittedAddItem: () => {
      const name = model.itemDraft.trim()

      if (!inputs.isStoreReady || model.isAddingItem || name === '') {
        return { model }
      }

      return Option.match(currentList(model, inputs), {
        onNone: () => ({ model }),
        onSome: list => ({
          model: modifyFields(model, {
            isAddingItem: () => true,
            maybeDetailError: () => Option.none(),
          }),
          commands: [
            CreateListItem({
              listId: list.id,
              name,
              order: nextItemOrder(
                listItemsFor(inputs.mirror.listItems, list.id),
              ),
              visibility: list.visibility,
            }),
          ],
        }),
      })
    },

    CompletedCreateListItem: ({ name }) => ({
      model: modifyFields(model, {
        isAddingItem: () => false,
        itemDraft: () =>
          model.itemDraft.trim() === name ? '' : model.itemDraft,
        maybeDetailError: () => Option.none(),
        announcement: () => `مورد تازه: ${name}`,
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedCreateListItem: ({ message }) => {
      const failed = withDetailError(model, message)
      return {
        model: modifyFields(failed.model, { isAddingItem: () => false }),
      }
    },

    ClickedToggleItem: ({ itemId }) =>
      Option.match(
        Array.findFirst(inputs.mirror.listItems, item => item.id === itemId),
        {
          onNone: () => ({ model }),
          onSome: item => ({
            model: modifyFields(model, {
              maybeDetailError: () => Option.none(),
            }),
            commands: [
              SetListItemChecked({
                itemId,
                name: item.name,
                checked: !item.done,
                wasDone: item.done,
                maybeCheckedAt: Option.fromNullishOr(item.checkedAt),
              }),
            ],
          }),
        },
      ),

    CompletedSetListItemChecked: ({ itemId, name, checked }) =>
      checked
        ? {
            model: modifyFields(model, {
              maybeDetailError: () => Option.none(),
              maybeToast: () => Option.some({ id: itemId, name }),
              toastGeneration: () => model.toastGeneration + 1,
              announcement: () => `تیک خورد: ${name}`,
            }),
            commands: [
              WaitBeforeDismissToast({
                itemId,
                generation: model.toastGeneration + 1,
              }),
            ],
            outMessage: OutMessage.WroteLocalData(),
          }
        : {
            model: modifyFields(model, {
              maybeDetailError: () => Option.none(),
              maybeToast: () =>
                Option.exists(model.maybeToast, toast => toast.id === itemId)
                  ? Option.none()
                  : model.maybeToast,
              announcement: () => `تیک برداشته شد: ${name}`,
            }),
            outMessage: OutMessage.WroteLocalData(),
          },

    FailedSetListItemChecked: ({ message }) => withDetailError(model, message),

    ClickedUndoChecked: () =>
      Option.match(model.maybeToast, {
        onNone: () => ({ model }),
        onSome: toast => ({
          model: modifyFields(model, {
            maybeToast: () => Option.none(),
            maybeDetailError: () => Option.none(),
          }),
          commands: [UncheckListItem({ itemId: toast.id, name: toast.name })],
        }),
      }),

    CompletedUncheckListItem: ({ name }) => ({
      model: modifyFields(model, {
        maybeDetailError: () => Option.none(),
        announcement: () => `بازگردانی شد: ${name}`,
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedUncheckListItem: ({ message }) => withDetailError(model, message),

    CompletedWaitBeforeDismissToast: ({ itemId, generation }) => ({
      model: modifyFields(model, {
        maybeToast: () =>
          generation === model.toastGeneration &&
          Option.exists(model.maybeToast, toast => toast.id === itemId)
            ? Option.none()
            : model.maybeToast,
      }),
    }),

    ClickedDeleteItem: ({ itemId, name }) => ({
      model: modifyFields(model, { maybeDetailError: () => Option.none() }),
      commands: [DeleteListItem({ itemId, name })],
    }),

    CompletedDeleteListItem: ({ itemId, name }) => ({
      model: modifyFields(model, {
        maybeDetailError: () => Option.none(),
        maybeToast: () =>
          Option.exists(model.maybeToast, toast => toast.id === itemId)
            ? Option.none()
            : model.maybeToast,
        announcement: () => `مورد حذف شد: ${name}`,
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedDeleteListItem: ({ message }) => withDetailError(model, message),

    ClickedMoveItem: ({ itemId, direction }) =>
      moveItem(model, inputs, itemId, direction),

    CompletedReorderListItems: () => ({
      model: modifyFields(model, {
        maybeDetailError: () => Option.none(),
        announcement: () => 'ترتیب موارد به‌روز شد',
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedReorderListItems: ({ message }) => withDetailError(model, message),

    StartedDraggingItem: ({ itemId }) =>
      Option.exists(currentList(model, inputs), list => list.sort === 'manual')
        ? {
            model: modifyFields(model, {
              maybeDraggingId: () => Option.some(itemId),
              maybeDragOverId: () => Option.none(),
            }),
          }
        : { model },

    EnteredDragTarget: ({ itemId }) =>
      Option.isSome(model.maybeDraggingId)
        ? {
            model: modifyFields(model, {
              maybeDragOverId: () => Option.some(itemId),
            }),
          }
        : { model },

    LeftDragTarget: ({ itemId }) => ({
      model: modifyFields(model, {
        maybeDragOverId: () =>
          Option.contains(model.maybeDragOverId, itemId)
            ? Option.none()
            : model.maybeDragOverId,
      }),
    }),

    DroppedOnItem: ({ itemId }) => dropItem(model, inputs, itemId),

    EndedDragItem: () => ({
      model: modifyFields(model, {
        maybeDraggingId: () => Option.none(),
        maybeDragOverId: () => Option.none(),
      }),
    }),
  })

// ENTRY CAPABILITIES

/** The root folds this when the index route is entered. */
export const enteredIndex = (model: Model): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    indexTitle: () => '',
    indexColor: () => COLOR_CHOICES[0] ?? '',
    indexIcon: () => ICON_CHOICES[0] ?? '',
    indexVisibility: () => 'shared',
    isCreating: () => false,
    maybeIndexError: () => Option.none(),
    isDetailLoading: () => false,
    announcement: () => '',
  }),
})

/**
 * A mirror read settled: stop treating an absent list as still loading and
 * retire any optimistic setting the authoritative row now agrees with.
 */
export const mirrorSettled = (
  model: Model,
  maybeInputs?: Inputs,
): Update.Return<Model, Message> => {
  const cleared = Option.match(Option.fromNullishOr(maybeInputs), {
    onNone: () => model,
    onSome: inputs =>
      Option.match(currentList(model, inputs), {
        onNone: () => model,
        onSome: list =>
          modifyFields(model, {
            maybeSortDraft: () =>
              Option.contains(model.maybeSortDraft, list.sort)
                ? Option.none()
                : model.maybeSortDraft,
            maybePlacementDraft: () =>
              Option.contains(model.maybePlacementDraft, list.checkedPlacement)
                ? Option.none()
                : model.maybePlacementDraft,
            maybeVisibilityDraft: () =>
              Option.contains(model.maybeVisibilityDraft, list.visibility)
                ? Option.none()
                : model.maybeVisibilityDraft,
          }),
      }),
  })

  return {
    model: modifyFields(cleared, { isDetailLoading: () => false }),
  }
}

/** The root folds this when the detail route is entered or its id changes. */
export const enteredDetail = (
  model: Model,
  options: Readonly<{ listId: ListId }>,
): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    maybeListId: () => Option.some(options.listId),
    maybeTitleDraft: () => Option.none(),
    maybeSortDraft: () => Option.none(),
    maybePlacementDraft: () => Option.none(),
    maybeVisibilityDraft: () => Option.none(),
    isRenaming: () => false,
    itemDraft: () => '',
    isAddingItem: () => false,
    isDeletingList: () => false,
    isDetailLoading: () => true,
    maybeDetailError: () => Option.none(),
    maybeToast: () => Option.none(),
    toastGeneration: () => 0,
    maybeDraggingId: () => Option.none(),
    maybeDragOverId: () => Option.none(),
    announcement: () => '',
  }),
})

// VIEW

export const indexView = Submodel.defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => listsIndexView(model, inputs, h),
)

export const detailView = Submodel.defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => listDetailView(model, inputs, h),
)
