import { Option } from 'effect'
import { Animation, Dialog, Toast as UiToast } from '@foldkit/ui'
import { test as toastTest } from '@foldkit/ui/toast'
import {
  Command,
  expectNoOutMessage,
  expectOutMessage,
  given,
  message,
  model,
  story,
} from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import { ListId } from '@tali/domain'

import { COLOR_CHOICES, ICON_CHOICES } from '../lists-model'
import { Toast } from '../ui/toast'
import * as Lists from './lists'
import type { Inputs, Model } from './lists'
import {
  CHECKED_ITEM_ID,
  ITEM_ID,
  LIST_ID,
  THIRD_ITEM_ID,
  checkedItemRow,
  detailModel,
  listInputs,
  listItemRow,
  listRow,
  mirrorWith,
  thirdItemRow,
} from './lists-test-fixtures'

const update = (inputs: Inputs) => (lists: Model, message: Lists.Message) =>
  Lists.update(lists, message, inputs)

const defaultUpdate = update(listInputs())

const threeItems = (): Inputs =>
  listInputs({
    mirror: mirrorWith(
      [listRow()],
      [listItemRow(), checkedItemRow(), thirdItemRow()],
    ),
  })

const openDetail = (): Model => detailModel()

describe('list index create', () => {
  test('submits the trimmed title with the form choices and preferred placement', () => {
    story(
      update(listInputs({ checkedItemPlacement: 'inPlace' })),
      given(
        modifyFields(Lists.initialModel(), {
          indexTitle: () => '  خرید  ',
          indexColor: () => COLOR_CHOICES[2] ?? '',
          indexIcon: () => ICON_CHOICES[3] ?? '',
          indexVisibility: () => 'private' as const,
        }),
      ),
      message(Lists.Message.SubmittedCreateList()),
      Command.expectExact(
        Lists.CreateList({
          title: 'خرید',
          color: COLOR_CHOICES[2] ?? '',
          icon: ICON_CHOICES[3] ?? '',
          sort: 'manual',
          checkedPlacement: 'inPlace',
          visibility: 'private',
        }),
      ),
      model(next => {
        expect(next.isCreating).toBe(true)
      }),
      Command.resolve(
        Lists.CreateList,
        Lists.Message.CompletedCreateList({
          listId: LIST_ID,
          title: 'خرید',
        }),
      ),
      model(next => {
        expect(next.isCreating).toBe(false)
        expect(next.indexTitle).toBe('')
        expect(next.maybeIndexError).toStrictEqual(Option.none())
      }),
      expectOutMessage(Lists.OutMessage.CreatedList({ listId: LIST_ID })),
    )
  })

  test('an empty title creates nothing', () => {
    story(
      defaultUpdate,
      given(modifyFields(Lists.initialModel(), { indexTitle: () => '   ' })),
      message(Lists.Message.SubmittedCreateList()),
      Command.expectNone(),
    )
  })

  test('a closed store creates nothing', () => {
    story(
      update(listInputs({ isStoreReady: false })),
      given(modifyFields(Lists.initialModel(), { indexTitle: () => 'خرید' })),
      message(Lists.Message.SubmittedCreateList()),
      Command.expectNone(),
    )
  })

  test('a create failure keeps the title for a retry and shows the error', () => {
    story(
      defaultUpdate,
      given(modifyFields(Lists.initialModel(), { indexTitle: () => 'خرید' })),
      message(Lists.Message.SubmittedCreateList()),
      Command.resolve(
        Lists.CreateList,
        Lists.Message.FailedCreateList({ message: 'حافظه پر است' }),
      ),
      model(next => {
        expect(next.isCreating).toBe(false)
        expect(next.indexTitle).toBe('خرید')
        expect(next.maybeIndexError).toStrictEqual(Option.some('حافظه پر است'))
      }),
      expectNoOutMessage(),
    )
  })

  test('the colour and icon pickers only accept the offered choices', () => {
    story(
      defaultUpdate,
      given(Lists.initialModel()),
      message(Lists.Message.SelectedIndexColor({ color: 'not-a-choice' })),
      message(Lists.Message.SelectedIndexIcon({ icon: 'not-a-choice' })),
      model(next => {
        expect(next.indexColor).toBe(COLOR_CHOICES[0])
        expect(next.indexIcon).toBe(ICON_CHOICES[0])
      }),
    )
  })

  test('the private checkbox flips the draft visibility', () => {
    story(
      defaultUpdate,
      given(Lists.initialModel()),
      message(Lists.Message.ToggledIndexVisibility({ isPrivate: true })),
      model(next => {
        expect(next.indexVisibility).toBe('private')
      }),
      message(Lists.Message.ToggledIndexVisibility({ isPrivate: false })),
      model(next => {
        expect(next.indexVisibility).toBe('shared')
      }),
    )
  })
})

describe('list deletion', () => {
  test('asks for confirmation and then deletes the list with its items', () => {
    story(
      update(threeItems()),
      given(Lists.initialModel()),
      message(
        Lists.Message.ClickedDeleteList({
          listId: LIST_ID,
          title: 'خرید هفتگی',
          scope: 'index',
        }),
      ),
      model(next => {
        expect(next.maybePendingDelete).toEqual(
          Option.some(
            Lists.PendingListDelete.make({
              listId: LIST_ID,
              title: 'خرید هفتگی',
              scope: 'index',
            }),
          ),
        )
        expect(next.confirmDialog.isOpen).toBe(true)
      }),
      Command.resolve(
        Dialog.ShowDialog,
        Dialog.Message.SucceededShowDialog(),
      ),
      message(Lists.Message.ConfirmedDeleteList()),
      Command.resolve(
        Dialog.CloseDialog,
        Dialog.Message.CompletedCloseDialog(),
      ),
      Command.expectExact(
        Lists.DeleteList({
          listId: LIST_ID,
          itemIds: [ITEM_ID, CHECKED_ITEM_ID, THIRD_ITEM_ID],
        }),
      ),
      Command.resolve(
        Lists.DeleteList,
        Lists.Message.CompletedDeleteList({ listId: LIST_ID }),
      ),
      model(next => {
        expect(next.isDeletingList).toBe(false)
      }),
      expectOutMessage(Lists.OutMessage.DeletedList({ listId: LIST_ID })),
    )
  })

  test('a cancelled confirmation deletes nothing', () => {
    story(
      defaultUpdate,
      given(Lists.initialModel()),
      message(
        Lists.Message.ClickedDeleteList({
          listId: LIST_ID,
          title: 'خرید هفتگی',
          scope: 'detail',
        }),
      ),
      model(next => {
        expect(next.maybePendingDelete).toEqual(
          Option.some(
            Lists.PendingListDelete.make({
              listId: LIST_ID,
              title: 'خرید هفتگی',
              scope: 'detail',
            }),
          ),
        )
        expect(next.confirmDialog.isOpen).toBe(true)
      }),
      Command.resolve(
        Dialog.ShowDialog,
        Dialog.Message.SucceededShowDialog(),
      ),
      message(
        Lists.Message.GotConfirmDialogMessage({
          message: Dialog.Message.RequestedClose(),
        }),
      ),
      Command.resolve(
        Dialog.CloseDialog,
        Dialog.Message.CompletedCloseDialog(),
      ),
      model(next => {
        expect(next.maybePendingDelete).toEqual(Option.none())
        expect(next.confirmDialog.isOpen).toBe(false)
      }),
      Command.expectNone(),
    )
  })
})

describe('list rename', () => {
  test('submits the trimmed draft and clears it on success', () => {
    story(
      defaultUpdate,
      given(
        modifyFields(openDetail(), {
          maybeTitleDraft: () => Option.some('  خرید تازه  '),
        }),
      ),
      message(Lists.Message.SubmittedRenameList()),
      Command.expectExact(
        Lists.RenameList({ listId: LIST_ID, title: 'خرید تازه' }),
      ),
      Command.resolve(
        Lists.RenameList,
        Lists.Message.CompletedRenameList({
          listId: LIST_ID,
          title: 'خرید تازه',
        }),
      ),
      model(next => {
        expect(next.isRenaming).toBe(false)
        expect(next.maybeTitleDraft).toStrictEqual(Option.none())
      }),
      expectOutMessage(Lists.OutMessage.WroteLocalData()),
    )
  })

  test('an unchanged or blank title never reaches the store', () => {
    story(
      defaultUpdate,
      given(
        modifyFields(openDetail(), {
          maybeTitleDraft: () => Option.some('خرید هفتگی'),
        }),
      ),
      message(Lists.Message.SubmittedRenameList()),
      model(next => {
        expect(next.maybeTitleDraft).toStrictEqual(Option.none())
      }),
      Command.expectNone(),
    )

    story(
      defaultUpdate,
      given(
        modifyFields(openDetail(), {
          maybeTitleDraft: () => Option.some('   '),
        }),
      ),
      message(Lists.Message.SubmittedRenameList()),
      model(next => {
        expect(next.maybeTitleDraft).toStrictEqual(Option.none())
      }),
      Command.expectNone(),
    )
  })

  test('a failed rename keeps the draft for a retry', () => {
    story(
      defaultUpdate,
      given(
        modifyFields(openDetail(), {
          maybeTitleDraft: () => Option.some('تازه'),
        }),
      ),
      message(Lists.Message.SubmittedRenameList()),
      Command.resolve(
        Lists.RenameList,
        Lists.Message.FailedRenameList({ message: 'ذخیره نشد' }),
      ),
      model(next => {
        expect(next.isRenaming).toBe(false)
        expect(next.maybeTitleDraft).toStrictEqual(Option.some('تازه'))
        expect(next.maybeDetailError).toStrictEqual(Option.some('ذخیره نشد'))
      }),
    )
  })

  test('blur reverts a blank draft and accepts a changed one', () => {
    story(
      defaultUpdate,
      given(
        modifyFields(openDetail(), {
          maybeTitleDraft: () => Option.some('   '),
        }),
      ),
      message(Lists.Message.BlurredTitleInput()),
      model(next => {
        expect(next.maybeTitleDraft).toStrictEqual(Option.none())
      }),
    )
  })
})

describe('list preferences', () => {
  test('each select writes the chosen field', () => {
    story(
      defaultUpdate,
      given(openDetail()),
      message(
        Lists.Message.SelectedListSort({ listId: LIST_ID, sort: 'alpha' }),
      ),
      Command.expectExact(
        Lists.SetListSort({ listId: LIST_ID, sort: 'alpha', revision: 1 }),
      ),
      Command.resolve(
        Lists.SetListSort,
        Lists.Message.CompletedSetListSort({ listId: LIST_ID }),
      ),
      message(
        Lists.Message.SelectedCheckedPlacement({
          listId: LIST_ID,
          placement: 'inPlace',
        }),
      ),
      Command.expectExact(
        Lists.SetCheckedPlacement({
          listId: LIST_ID,
          placement: 'inPlace',
          revision: 2,
        }),
      ),
      Command.resolve(
        Lists.SetCheckedPlacement,
        Lists.Message.CompletedSetCheckedPlacement({ listId: LIST_ID }),
      ),
      message(
        Lists.Message.SelectedListVisibility({
          listId: LIST_ID,
          visibility: 'private',
        }),
      ),
      Command.expectExact(
        Lists.SetListVisibility({
          listId: LIST_ID,
          visibility: 'private',
          revision: 3,
        }),
      ),
      Command.resolve(
        Lists.SetListVisibility,
        Lists.Message.CompletedSetListVisibility({ listId: LIST_ID }),
      ),
    )
  })

  test('a second choice before the mirror settles still writes', () => {
    story(
      defaultUpdate,
      given(openDetail()),
      message(
        Lists.Message.SelectedListSort({ listId: LIST_ID, sort: 'alpha' }),
      ),
      Command.expectExact(
        Lists.SetListSort({ listId: LIST_ID, sort: 'alpha', revision: 1 }),
      ),
      Command.resolve(
        Lists.SetListSort,
        Lists.Message.CompletedSetListSort({ listId: LIST_ID }),
      ),
      model(next => {
        expect(next.maybeSortDraft).toStrictEqual(Option.some('alpha'))
      }),
      message(
        Lists.Message.SelectedListSort({ listId: LIST_ID, sort: 'manual' }),
      ),
      Command.expectExact(
        Lists.SetListSort({ listId: LIST_ID, sort: 'manual', revision: 2 }),
      ),
      Command.resolve(
        Lists.SetListSort,
        Lists.Message.CompletedSetListSort({ listId: LIST_ID }),
      ),
      model(next => {
        expect(next.maybeSortDraft).toStrictEqual(Option.some('manual'))
      }),
    )
  })

  test('choosing the current value writes nothing', () => {
    story(
      defaultUpdate,
      given(openDetail()),
      message(
        Lists.Message.SelectedListSort({ listId: LIST_ID, sort: 'manual' }),
      ),
      message(
        Lists.Message.SelectedCheckedPlacement({
          listId: LIST_ID,
          placement: 'bottom',
        }),
      ),
      message(
        Lists.Message.SelectedListVisibility({
          listId: LIST_ID,
          visibility: 'shared',
        }),
      ),
      Command.expectNone(),
    )
  })

  test('only the owner may change visibility', () => {
    story(
      update(listInputs({ maybeUserId: Option.some('someone-else') })),
      given(openDetail()),
      message(
        Lists.Message.SelectedListVisibility({
          listId: LIST_ID,
          visibility: 'private',
        }),
      ),
      Command.expectNone(),
    )
  })
})

describe('list items', () => {
  test('continuous entry appends the next order and clears only the submitted name', () => {
    story(
      defaultUpdate,
      given(modifyFields(openDetail(), { itemDraft: () => 'نان' })),
      message(Lists.Message.SubmittedAddItem()),
      Command.expectExact(
        Lists.CreateListItem({
          listId: LIST_ID,
          name: 'نان',
          order: 2,
          visibility: 'shared',
        }),
      ),
      Command.resolve(
        Lists.CreateListItem,
        Lists.Message.CompletedCreateListItem({
          listId: LIST_ID,
          itemId: CHECKED_ITEM_ID,
          name: 'نان',
        }),
      ),
      model(next => {
        expect(next.isAddingItem).toBe(false)
        expect(next.itemDraft).toBe('')
      }),
      expectOutMessage(Lists.OutMessage.WroteLocalData()),
    )
  })

  test('a next draft typed while the write settles is not cleared', () => {
    story(
      defaultUpdate,
      given(modifyFields(openDetail(), { itemDraft: () => 'شیر' })),
      message(
        Lists.Message.CompletedCreateListItem({
          listId: LIST_ID,
          itemId: ITEM_ID,
          name: 'نان',
        }),
      ),
      model(next => {
        expect(next.isAddingItem).toBe(false)
        expect(next.itemDraft).toBe('شیر')
      }),
      expectOutMessage(Lists.OutMessage.WroteLocalData()),
    )
  })

  test('the submitted name is cleared when it is still the draft', () => {
    story(
      defaultUpdate,
      given(modifyFields(openDetail(), { itemDraft: () => 'نان' })),
      message(Lists.Message.SubmittedAddItem()),
      Command.resolve(
        Lists.CreateListItem,
        Lists.Message.CompletedCreateListItem({
          listId: LIST_ID,
          itemId: ITEM_ID,
          name: 'نان',
        }),
      ),
      model(next => {
        expect(next.itemDraft).toBe('')
      }),
    )
  })

  test('an empty draft or closed store adds nothing', () => {
    story(
      defaultUpdate,
      given(openDetail()),
      message(Lists.Message.SubmittedAddItem()),
      Command.expectNone(),
    )

    story(
      update(listInputs({ isStoreReady: false })),
      given(modifyFields(openDetail(), { itemDraft: () => 'نان' })),
      message(Lists.Message.SubmittedAddItem()),
      Command.expectNone(),
    )
  })

  test('checking an item queues the audit timestamp and shows the undo toast', () => {
    story(
      defaultUpdate,
      given(openDetail()),
      message(Lists.Message.ClickedToggleItem({ itemId: ITEM_ID })),
      Command.expectExact(
        Lists.SetListItemChecked({
          itemId: ITEM_ID,
          name: 'نان',
          checked: true,
          wasDone: false,
          maybeCheckedAt: Option.none(),
        }),
      ),
      Command.resolve(
        Lists.SetListItemChecked,
        Lists.Message.CompletedSetListItemChecked({
          itemId: ITEM_ID,
          name: 'نان',
          checked: true,
        }),
      ),
      model(next => {
        expect(next.toast.entries).toHaveLength(1)
        expect(next.toast.entries[0]?.payload.text).toBe('تیک خورد: نان')
        expect(
          next.toast.entries[0]?.payload.maybeUndo,
        ).toStrictEqual({
          kind: 'uncheckItem',
          id: ITEM_ID,
          title: 'نان',
        })
      }),
      expectOutMessage(Lists.OutMessage.WroteLocalData()),
      toastTest.drainEntry({ entryId: 'lists-toast-entry-0' }),
      model(next => {
        expect(next.toast.entries).toHaveLength(0)
      }),
    )
  })

  test('unchecking a done item does not show a toast', () => {
    story(
      update(threeItems()),
      given(openDetail()),
      message(Lists.Message.ClickedToggleItem({ itemId: CHECKED_ITEM_ID })),
      Command.expectExact(
        Lists.SetListItemChecked({
          itemId: CHECKED_ITEM_ID,
          name: 'شیر',
          checked: false,
          wasDone: true,
          maybeCheckedAt: Option.some('2026-10-20T09:30:00.000Z'),
        }),
      ),
      Command.resolve(
        Lists.SetListItemChecked,
        Lists.Message.CompletedSetListItemChecked({
          itemId: CHECKED_ITEM_ID,
          name: 'شیر',
          checked: false,
        }),
      ),
      model(next => {
        expect(next.toast.entries).toHaveLength(0)
      }),
      expectOutMessage(Lists.OutMessage.WroteLocalData()),
    )
  })

  test('undo clears the toast immediately and forces the unchecked write', () => {
    story(
      defaultUpdate,
      given(openDetail()),
      message(Lists.Message.ClickedToggleItem({ itemId: ITEM_ID })),
      Command.resolve(
        Lists.SetListItemChecked,
        Lists.Message.CompletedSetListItemChecked({
          itemId: ITEM_ID,
          name: 'نان',
          checked: true,
        }),
      ),
      Command.resolve(
        Animation.WaitForPaint,
        Animation.Message.CompletedWaitForPaint({ generation: 1 }),
      ),
      Command.resolve(
        Animation.WaitForAnimationSettled,
        Animation.Message.EndedAnimation({ generation: 1 }),
      ),
      Command.resolve(
        UiToast.WaitBeforeDismissal,
        UiToast.Message.CompletedWaitBeforeDismissal({
          entryId: 'lists-toast-entry-0',
          version: 1,
        }),
      ),
      message(
        Lists.Message.ClickedUndoChecked({
          entryId: 'lists-toast-entry-0',
          undo: { kind: 'uncheckItem', id: ITEM_ID, title: 'نان' },
        }),
      ),
      expectOutMessage(Lists.OutMessage.WroteLocalData()),
      model(next => {
        expect(
          next.toast.entries.every(
            entry => entry.animation.transitionState !== 'Idle',
          ),
        ).toBe(true)
      }),
      Command.resolve(
        Animation.WaitForPaint,
        Animation.Message.CompletedWaitForPaint({ generation: 2 }),
      ),
      Command.resolve(
        Animation.WaitForAnimationSettled,
        Animation.Message.EndedAnimation({ generation: 2 }),
      ),
      Command.expectExact(
        Lists.UncheckListItem({ itemId: ITEM_ID, name: 'نان' }),
      ),
      Command.resolve(
        Lists.UncheckListItem,
        Lists.Message.CompletedUncheckListItem({
          itemId: ITEM_ID,
          name: 'نان',
        }),
      ),
      model(next => {
        expect(next.toast.entries).toHaveLength(0)
      }),
    )
  })

  test('deleting an item clears a toast that belongs to it', () => {
    story(
      defaultUpdate,
      given(openDetail()),
      message(Lists.Message.ClickedToggleItem({ itemId: ITEM_ID })),
      Command.resolve(
        Lists.SetListItemChecked,
        Lists.Message.CompletedSetListItemChecked({
          itemId: ITEM_ID,
          name: 'نان',
          checked: true,
        }),
      ),
      Command.resolve(
        Animation.WaitForPaint,
        Animation.Message.CompletedWaitForPaint({ generation: 1 }),
      ),
      Command.resolve(
        Animation.WaitForAnimationSettled,
        Animation.Message.EndedAnimation({ generation: 1 }),
      ),
      Command.resolve(
        UiToast.WaitBeforeDismissal,
        UiToast.Message.CompletedWaitBeforeDismissal({
          entryId: 'lists-toast-entry-0',
          version: 1,
        }),
      ),
      message(
        Lists.Message.ClickedDeleteItem({ itemId: ITEM_ID, name: 'نان' }),
      ),
      Command.expectExact(
        Lists.DeleteListItem({ itemId: ITEM_ID, name: 'نان' }),
      ),
      Command.resolve(
        Lists.DeleteListItem,
        Lists.Message.CompletedDeleteListItem({
          itemId: ITEM_ID,
          name: 'نان',
        }),
      ),
      expectOutMessage(Lists.OutMessage.WroteLocalData()),
      model(next => {
        expect(
          next.toast.entries.every(
            entry => entry.animation.transitionState !== 'Idle',
          ),
        ).toBe(true)
      }),
      Command.resolve(
        Animation.WaitForPaint,
        Animation.Message.CompletedWaitForPaint({ generation: 2 }),
      ),
      Command.resolve(
        Animation.WaitForAnimationSettled,
        Animation.Message.EndedAnimation({ generation: 2 }),
      ),
      model(next => {
        expect(next.toast.entries).toHaveLength(0)
      }),
    )
  })

  test('a failed local write surfaces the store message', () => {
    story(
      defaultUpdate,
      given(openDetail()),
      message(Lists.Message.ClickedToggleItem({ itemId: ITEM_ID })),
      Command.resolve(
        Lists.SetListItemChecked,
        Lists.Message.FailedSetListItemChecked({
          message: 'حافظه‌ی محلی پاسخ نداد',
        }),
      ),
      model(next => {
        expect(next.maybeDetailError).toStrictEqual(
          Option.some('حافظه‌ی محلی پاسخ نداد'),
        )
      }),
    )
  })
})

describe('manual ordering', () => {
  test('moving a row down writes the whole manual sequence', () => {
    story(
      update(threeItems()),
      given(openDetail()),
      message(
        Lists.Message.ClickedMoveItem({ itemId: ITEM_ID, direction: 'down' }),
      ),
      Command.expectExact(
        Lists.ReorderListItems({
          listId: LIST_ID,
          orderedIds: [CHECKED_ITEM_ID, ITEM_ID, THIRD_ITEM_ID],
        }),
      ),
      Command.resolve(
        Lists.ReorderListItems,
        Lists.Message.CompletedReorderListItems(),
      ),
      expectOutMessage(Lists.OutMessage.WroteLocalData()),
    )
  })

  test('the first row cannot move up and the last cannot move down', () => {
    story(
      update(threeItems()),
      given(openDetail()),
      message(
        Lists.Message.ClickedMoveItem({ itemId: ITEM_ID, direction: 'up' }),
      ),
      Command.expectNone(),
      message(
        Lists.Message.ClickedMoveItem({
          itemId: THIRD_ITEM_ID,
          direction: 'down',
        }),
      ),
      Command.expectNone(),
    )
  })

  test('reordering is unavailable outside manual sort', () => {
    const inputs = listInputs({
      mirror: mirrorWith(
        [listRow({ sort: 'alpha' })],
        [listItemRow(), checkedItemRow()],
      ),
    })

    story(
      update(inputs),
      given(openDetail()),
      message(
        Lists.Message.ClickedMoveItem({ itemId: ITEM_ID, direction: 'down' }),
      ),
      Command.expectNone(),
    )
  })

  test('dropping a dragged row before another commits the new order', () => {
    story(
      update(threeItems()),
      given(openDetail()),
      message(Lists.Message.StartedDraggingItem({ itemId: THIRD_ITEM_ID })),
      message(Lists.Message.EnteredDragTarget({ itemId: ITEM_ID })),
      model(next => {
        expect(next.maybeDraggingId).toStrictEqual(Option.some(THIRD_ITEM_ID))
        expect(next.maybeDragOverId).toStrictEqual(Option.some(ITEM_ID))
      }),
      message(Lists.Message.DroppedOnItem({ itemId: ITEM_ID })),
      model(next => {
        expect(next.maybeDraggingId).toStrictEqual(Option.none())
        expect(next.maybeDragOverId).toStrictEqual(Option.none())
      }),
      Command.expectExact(
        Lists.ReorderListItems({
          listId: LIST_ID,
          orderedIds: [THIRD_ITEM_ID, ITEM_ID, CHECKED_ITEM_ID],
        }),
      ),
      Command.resolve(
        Lists.ReorderListItems,
        Lists.Message.CompletedReorderListItems(),
      ),
      expectOutMessage(Lists.OutMessage.WroteLocalData()),
    )
  })

  test('ending a drag clears both drag flags', () => {
    story(
      update(threeItems()),
      given(
        modifyFields(openDetail(), {
          maybeDraggingId: () => Option.some(ITEM_ID),
          maybeDragOverId: () => Option.some(THIRD_ITEM_ID),
        }),
      ),
      message(Lists.Message.EndedDragItem()),
      model(next => {
        expect(next.maybeDraggingId).toStrictEqual(Option.none())
        expect(next.maybeDragOverId).toStrictEqual(Option.none())
      }),
    )
  })
})

describe('entry capabilities', () => {
  test('entering the index resets the create form', () => {
    const entered = Lists.enteredIndex(
      modifyFields(Lists.initialModel(), {
        indexTitle: () => 'نیمه‌کاره',
        indexColor: () => COLOR_CHOICES[3] ?? '',
        indexIcon: () => ICON_CHOICES[4] ?? '',
        indexVisibility: () => 'private' as const,
        isCreating: () => true,
        maybeIndexError: () => Option.some('خطا'),
      }),
    ).model

    expect(entered.indexTitle).toBe('')
    expect(entered.indexColor).toBe(COLOR_CHOICES[0])
    expect(entered.indexIcon).toBe(ICON_CHOICES[0])
    expect(entered.indexVisibility).toBe('shared')
    expect(entered.isCreating).toBe(false)
    expect(entered.maybeIndexError).toStrictEqual(Option.none())
  })

  test('a settled mirror stops the detail loading state', () => {
    const loading = modifyFields(detailModel(), {
      isDetailLoading: () => true,
    })

    expect(Lists.mirrorSettled(loading).model.isDetailLoading).toBe(false)
  })

  test('entering a detail stores the typed id and resets transient state', () => {
    const listId = ListId.make(LIST_ID)
    const entered = Lists.enteredDetail(
      modifyFields(Lists.initialModel(), {
        itemDraft: () => 'نیمه‌کاره',
        maybeTitleDraft: () => Option.some('نیمه‌کاره'),
        toast: () => Toast.init({ id: 'lists-toast' }),
        maybeDraggingId: () => Option.some(ITEM_ID),
        maybeDetailError: () => Option.some('خطا'),
      }),
      { listId },
    ).model

    expect(entered.maybeListId).toStrictEqual(Option.some(listId))
    expect(entered.itemDraft).toBe('')
    expect(entered.maybeTitleDraft).toStrictEqual(Option.none())
    expect(entered.toast.entries).toHaveLength(0)
    expect(entered.maybeDraggingId).toStrictEqual(Option.none())
    expect(entered.maybeDetailError).toStrictEqual(Option.none())
  })
})
