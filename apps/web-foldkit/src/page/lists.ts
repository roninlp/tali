import { Array, Clock, Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { Dialog, Listbox } from '@foldkit/ui'
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
import type { ConfirmSpec } from '../ui/confirm'
import { confirmDialogFolds } from '../ui/confirm'
import { optionalListboxOutMessageFold } from '../ui/fold'
import { Toast, ToastUndo, toastFolds } from '../ui/toast'
import { listDetailView } from './list-view'
import { listsIndexView } from './lists-view'
import { localWrite, storeFailureMessage } from './local-write'

/**
 * The `/lists` index and `/lists/[id]` detail Submodel, ported from
 * `apps/web/src/components/lists/*` (ticket #39; FR-LIST-01/02/03).
 *
 * Both screens read the same mirror snapshot: the Model keeps their drafts,
 * busy flags, detail error, delete dialog and drag state, while the rows and
 * the pending keys arrive as update/view inputs. Every write goes through the
 * local store first (mirror row + outbox entry in one transaction), then the
 * root asks sync to re-read the mirror. No list write uses RPC.
 */

// MODEL

export const sortOfValue = (value: string): ListSort =>
  value === 'alpha' || value === 'status' ? value : 'manual'

export const placementOfValue = (value: string): CheckedPlacement =>
  value === 'inPlace' ? 'inPlace' : 'bottom'

export const visibilityOfValue = (value: string): ListVisibility =>
  value === 'private' ? 'private' : 'shared'

export const DeleteScope = Schema.Literals(['index', 'detail'])

export type DeleteScope = typeof DeleteScope.Type

export const PendingListDelete = Schema.Struct({
  listId: Schema.String,
  title: Schema.String,
  scope: DeleteScope,
})

export type PendingListDelete = typeof PendingListDelete.Type

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
  maybePendingDelete: Schema.Option(PendingListDelete),
  confirmDialog: Dialog.Model,
  toast: Toast.Model,
  maybeDraggingId: Schema.Option(Schema.String),
  maybeDragOverId: Schema.Option(Schema.String),
  announcement: Schema.String,
  sortListbox: Listbox.Model,
  placementListbox: Listbox.Model,
  visibilityListbox: Listbox.Model,
})

export type Model = typeof Model.Type

export type SortOption = Readonly<{ value: ListSort; label: string }>

export type PlacementOption = Readonly<{
  value: CheckedPlacement
  label: string
}>

export type VisibilityOption = Readonly<{
  value: ListVisibility
  label: string
}>

export const SortListbox = Listbox.create<SortOption, string>()
export const PlacementListbox = Listbox.create<PlacementOption, string>()
export const VisibilityListbox = Listbox.create<VisibilityOption, string>()

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
    maybePendingDelete: Option.none(),
    confirmDialog: Dialog.init({ id: 'lists-delete-dialog' }),
    toast: Toast.init({ id: 'lists-toast' }),
    maybeDraggingId: Option.none(),
    maybeDragOverId: Option.none(),
    announcement: '',
    sortListbox: Listbox.init({ id: 'list-sort-listbox' }),
    placementListbox: Listbox.init({ id: 'list-placement-listbox' }),
    visibilityListbox: Listbox.init({ id: 'list-visibility-listbox' }),
  })

// LISTBOX FOLDS

const sortListboxOutMessage = (inputs: Inputs) =>
  optionalListboxOutMessageFold<Model, Message, OutMessage, LocalStoreService>({
    handleUpdate: (model, message) => update(model, message, inputs),
    toMessage: (model, value) =>
      Option.map(model.maybeListId, listId =>
        Message.SelectedListSort({ listId, sort: sortOfValue(value) }),
      ),
  })

const placementListboxOutMessage = (inputs: Inputs) =>
  optionalListboxOutMessageFold<Model, Message, OutMessage, LocalStoreService>({
    handleUpdate: (model, message) => update(model, message, inputs),
    toMessage: (model, value) =>
      Option.map(model.maybeListId, listId =>
        Message.SelectedCheckedPlacement({
          listId,
          placement: placementOfValue(value),
        }),
      ),
  })

const visibilityListboxOutMessage = (inputs: Inputs) =>
  optionalListboxOutMessageFold<Model, Message, OutMessage, LocalStoreService>({
    handleUpdate: (model, message) => update(model, message, inputs),
    toMessage: (model, value) =>
      Option.map(model.maybeListId, listId =>
        Message.SelectedListVisibility({
          listId,
          visibility: visibilityOfValue(value),
        }),
      ),
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
  ConfirmedDeleteList: {},
  GotConfirmDialogMessage: { message: Dialog.Message },
  CompletedDeleteList: { listId: Schema.String },
  FailedDeleteList: { message: Schema.String },

  UpdatedTitleDraft: { value: Schema.String },
  GotSortListboxMessage: { message: Listbox.Message },
  GotPlacementListboxMessage: { message: Listbox.Message },
  GotVisibilityListboxMessage: { message: Listbox.Message },
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
  ClickedUndoChecked: { entryId: Schema.String, undo: ToastUndo },
  CompletedUncheckListItem: { itemId: Schema.String, name: Schema.String },
  FailedUncheckListItem: { message: Schema.String },
  GotToastMessage: { message: Toast.Message },
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
    localWrite({
      run: (store, now) => updateListInMirror(store, listId, { title }, now),
      onSuccess: () => Message.CompletedRenameList({ listId, title }),
      onFailure: message => Message.FailedRenameList({ message }),
    }),
})

export const SetListSort = Command.define('SetListSort', {
  args: { listId: Schema.String, sort: ListSort, revision: Schema.Int },
  messages: [Message.CompletedSetListSort, Message.FailedSetListSort],
  execute: ({ listId, sort, revision }) =>
    localWrite({
      run: (store, now) =>
        writeListSettingIfLatest(
          store,
          'sort',
          listId,
          revision,
          { sort },
          now,
        ),
      onSuccess: () => Message.CompletedSetListSort({ listId }),
      onFailure: message => Message.FailedSetListSort({ message }),
    }),
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
    localWrite({
      run: (store, now) =>
        writeListSettingIfLatest(
          store,
          'placement',
          listId,
          revision,
          { checkedPlacement: placement },
          now,
        ),
      onSuccess: () => Message.CompletedSetCheckedPlacement({ listId }),
      onFailure: message => Message.FailedSetCheckedPlacement({ message }),
    }),
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
    localWrite({
      run: (store, now) =>
        writeListSettingIfLatest(
          store,
          'visibility',
          listId,
          revision,
          { visibility },
          now,
        ),
      onSuccess: () => Message.CompletedSetListVisibility({ listId }),
      onFailure: message => Message.FailedSetListVisibility({ message }),
    }),
})

export const CreateListItem = Command.define('CreateListItem', {
  args: {
    listId: Schema.String,
    name: Schema.String,
    order: Schema.Int,
  },
  messages: [Message.CompletedCreateListItem, Message.FailedCreateListItem],
  execute: ({ listId, name, order }) =>
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
            { name, order },
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
    localWrite({
      run: (store, now) =>
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
      onSuccess: () =>
        Message.CompletedSetListItemChecked({ itemId, name, checked }),
      onFailure: message => Message.FailedSetListItemChecked({ message }),
    }),
})

export const UncheckListItem = Command.define('UncheckListItem', {
  args: { itemId: Schema.String, name: Schema.String },
  messages: [Message.CompletedUncheckListItem, Message.FailedUncheckListItem],
  execute: ({ itemId, name }) =>
    localWrite({
      run: (store, now) => uncheckListItemInMirror(store, itemId, now),
      onSuccess: () => Message.CompletedUncheckListItem({ itemId, name }),
      onFailure: message => Message.FailedUncheckListItem({ message }),
    }),
})

export const DeleteListItem = Command.define('DeleteListItem', {
  args: { itemId: Schema.String, name: Schema.String },
  messages: [Message.CompletedDeleteListItem, Message.FailedDeleteListItem],
  execute: ({ itemId, name }) =>
    localWrite({
      run: (store, now) => deleteListItemInMirror(store, itemId, now),
      onSuccess: () => Message.CompletedDeleteListItem({ itemId, name }),
      onFailure: message => Message.FailedDeleteListItem({ message }),
    }),
})

export const ReorderListItems = Command.define('ReorderListItems', {
  args: { listId: Schema.String, orderedIds: Schema.Array(Schema.String) },
  messages: [Message.CompletedReorderListItems, Message.FailedReorderListItems],
  execute: ({ orderedIds }) =>
    localWrite({
      run: async (store, now) => {
        const items = await readListItems(store)

        return reorderListItemsInMirror(store, items, orderedIds, now)
      },
      onSuccess: () => Message.CompletedReorderListItems(),
      onFailure: message => Message.FailedReorderListItems({ message }),
    }),
})

export const DeleteList = Command.define('DeleteList', {
  args: {
    listId: Schema.String,
    itemIds: Schema.Array(Schema.String),
  },
  messages: [Message.CompletedDeleteList, Message.FailedDeleteList],
  execute: ({ listId, itemIds }) =>
    localWrite({
      run: (store, now) => deleteListInMirror(store, listId, itemIds, now),
      onSuccess: () => Message.CompletedDeleteList({ listId }),
      onFailure: message => Message.FailedDeleteList({ message }),
    }),
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

const confirmDialog = confirmDialogFolds<Model, Message>({
  field: model => model.confirmDialog,
  setField: (model, nextDialog) =>
    modifyFields(model, { confirmDialog: () => nextDialog }),
  toParentMessage: message => Message.GotConfirmDialogMessage({ message }),
  whenClosed: model =>
    modifyFields(model, { maybePendingDelete: () => Option.none() }),
})

const foldConfirmDialog = confirmDialog.fold
const foldConfirmDialogOpen = confirmDialog.openStep
const foldConfirmDialogClose = confirmDialog.closeStep

const toast = toastFolds<Model, Message>({
  field: model => model.toast,
  setField: (model, nextToast) =>
    modifyFields(model, { toast: () => nextToast }),
  toParentMessage: message => Message.GotToastMessage({ message }),
})

const foldToast = toast.fold
const dismissedToastStep = toast.dismissedStep

const shownCheckedToastStep = (
  itemId: string,
  name: string,
): Update.Step<Model, Message> =>
  toast.shownStep(
    {
      text: `تیک خورد: ${name}`,
      maybeUndo: {
        kind: 'uncheckItem',
        id: itemId,
        title: name,
      },
    },
    'Success',
  )

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
): UpdateReturn => {
  const foldSortListbox = Update.foldChild({
    update: SortListbox.update,
    read: (listModel: Model) => Option.some(listModel.sortListbox),
    write: (listModel: Model, nextListbox: Listbox.Model) =>
      modifyFields(listModel, { sortListbox: () => nextListbox }),
    toParentMessage: message => Message.GotSortListboxMessage({ message }),
    foldOutMessage: sortListboxOutMessage(inputs),
  })

  const foldPlacementListbox = Update.foldChild({
    update: PlacementListbox.update,
    read: (listModel: Model) => Option.some(listModel.placementListbox),
    write: (listModel: Model, nextListbox: Listbox.Model) =>
      modifyFields(listModel, { placementListbox: () => nextListbox }),
    toParentMessage: message => Message.GotPlacementListboxMessage({ message }),
    foldOutMessage: placementListboxOutMessage(inputs),
  })

  const foldVisibilityListbox = Update.foldChild({
    update: VisibilityListbox.update,
    read: (listModel: Model) => Option.some(listModel.visibilityListbox),
    write: (listModel: Model, nextListbox: Listbox.Model) =>
      modifyFields(listModel, { visibilityListbox: () => nextListbox }),
    toParentMessage: message =>
      Message.GotVisibilityListboxMessage({ message }),
    foldOutMessage: visibilityListboxOutMessage(inputs),
  })

  return Message.match<UpdateReturn>(message, {
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

    ClickedDeleteList: ({ listId, title, scope }) =>
      Update.combine(model, [
        foldConfirmDialogOpen,
        stepModel => ({
          model: modifyFields(stepModel, {
            maybePendingDelete: () =>
              Option.some(PendingListDelete.make({ listId, title, scope })),
          }),
        }),
      ]),

    ConfirmedDeleteList: () =>
      Option.match(model.maybePendingDelete, {
        onNone: () => ({ model }),
        onSome: pending => {
          const itemIds = Array.map(
            listItemsFor(inputs.mirror.listItems, pending.listId),
            item => item.id,
          )

          return Update.combine(model, [
            foldConfirmDialogClose,
            stepModel => ({
              model: modifyFields(stepModel, {
                isDeletingList: () => true,
                maybeIndexError: () => Option.none(),
                maybeDetailError: () => Option.none(),
              }),
              commands: [DeleteList({ listId: pending.listId, itemIds })],
            }),
          ])
        },
      }),

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

    GotSortListboxMessage: ({ message }) => foldSortListbox(model, message),

    GotPlacementListboxMessage: ({ message }) =>
      foldPlacementListbox(model, message),

    GotVisibilityListboxMessage: ({ message }) =>
      foldVisibilityListbox(model, message),

    GotConfirmDialogMessage: ({ message }) => foldConfirmDialog(model, message),

    GotToastMessage: ({ message }) => foldToast(model, message),

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
        ? Update.withOutMessage(
            Update.combine(model, [
              shownCheckedToastStep(itemId, name),
              stepModel => ({
                model: modifyFields(stepModel, {
                  maybeDetailError: () => Option.none(),
                  announcement: () => `تیک خورد: ${name}`,
                }),
              }),
            ]),
            OutMessage.WroteLocalData(),
          )
        : {
            model: modifyFields(model, {
              maybeDetailError: () => Option.none(),
              announcement: () => `تیک برداشته شد: ${name}`,
            }),
            outMessage: OutMessage.WroteLocalData(),
          },

    FailedSetListItemChecked: ({ message }) => withDetailError(model, message),

    ClickedUndoChecked: ({ entryId, undo }) =>
      Update.withOutMessage(
        Update.combine(model, [
          dismissedToastStep(entryId),
          stepModel => ({
            model: modifyFields(stepModel, {
              maybeDetailError: () => Option.none(),
            }),
            commands: [UncheckListItem({ itemId: undo.id, name: undo.title })],
          }),
        ]),
        OutMessage.WroteLocalData(),
      ),

    CompletedUncheckListItem: ({ name }) => ({
      model: modifyFields(model, {
        maybeDetailError: () => Option.none(),
        announcement: () => `بازگردانی شد: ${name}`,
      }),
      outMessage: OutMessage.WroteLocalData(),
    }),

    FailedUncheckListItem: ({ message }) => withDetailError(model, message),

    ClickedDeleteItem: ({ itemId, name }) => ({
      model: modifyFields(model, { maybeDetailError: () => Option.none() }),
      commands: [DeleteListItem({ itemId, name })],
    }),

    CompletedDeleteListItem: ({ itemId, name }) =>
      Update.withOutMessage(
        Update.combine(model, [
          stepModel =>
            Update.combine(stepModel, [
              stepModel =>
                Option.match(
                  Array.findFirst(
                    stepModel.toast.entries,
                    entry =>
                      entry.payload.maybeUndo?.kind === 'uncheckItem' &&
                      entry.payload.maybeUndo.id === itemId,
                  ),
                  {
                    onNone: () => ({ model: stepModel }),
                    onSome: entry => dismissedToastStep(entry.id)(stepModel),
                  },
                ),
              stepModel => ({
                model: modifyFields(stepModel, {
                  maybeDetailError: () => Option.none(),
                  announcement: () => `مورد حذف شد: ${name}`,
                }),
              }),
            ]),
        ]),
        OutMessage.WroteLocalData(),
      ),

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
}

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
    maybePendingDelete: () => Option.none(),
    confirmDialog: () => Dialog.init({ id: 'lists-delete-dialog' }),
    toast: () => Toast.init({ id: 'lists-toast' }),
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

/** The shared confirm copy, resolved from the pending delete. */
export const confirmSpec = (model: Model): Option.Option<ConfirmSpec> =>
  Option.map(model.maybePendingDelete, pending => ({
    title: 'حذف فهرست',
    body: deleteQuestion(pending.scope, pending.title),
    confirmLabel: 'حذف',
    cancelLabel: 'انصراف',
    isDanger: true,
  }))
