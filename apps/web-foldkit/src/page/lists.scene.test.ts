import { Option } from 'effect'
import { Listbox } from '@foldkit/ui'
import {
  Command,
  Mount,
  all,
  click,
  expect,
  expectOutMessage,
  given,
  label,
  nth,
  role,
  scene,
  submit,
  text,
  type,
  withViewInputs,
  within,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { expect as assert, describe, test } from 'vitest'

import { emptyMirrorSnapshot } from '../mirror'
import { USER_ID } from '../test-fixtures'
import * as Lists from './lists'
import type { Inputs, Model } from './lists'
import {
  CHECKED_ITEM_ID,
  ITEM_ID,
  LIST_ID,
  SECOND_LIST_ID,
  checkedItemRow,
  checkedListRow,
  detailModel,
  listInputs,
  listItemRow,
  listRow,
  mirrorWith,
  thirdItemRow,
} from './lists-test-fixtures'

const indexScene = (model: Model, overrides: Partial<Inputs> = {}) => {
  const viewInputs = listInputs(overrides)

  return {
    update: (lists: Model, message: Lists.Message) =>
      Lists.update(lists, message, viewInputs),
    view: withViewInputs(Lists.indexView, viewInputs)(),
  }
}

const detailScene = (model: Model, overrides: Partial<Inputs> = {}) => {
  const viewInputs = listInputs(overrides)

  return {
    update: (lists: Model, message: Lists.Message) =>
      Lists.update(lists, message, viewInputs),
    view: withViewInputs(Lists.detailView, viewInputs)(),
  }
}

const withItems = (overrides: Partial<Inputs> = {}): Inputs =>
  listInputs({
    mirror: mirrorWith(
      [listRow()],
      [listItemRow(), checkedItemRow(), thirdItemRow()],
    ),
    ...overrides,
  })

describe('Lists index', () => {
  test('an empty index explains the one next action', () => {
    scene(
      indexScene(Lists.initialModel(), {
        mirror: emptyMirrorSnapshot(),
      }),
      given(Lists.initialModel()),
      expect(role('heading', { name: 'فهرست‌ها' })).toExist(),
      expect(
        text(
          'هنوز فهرستی نساخته‌اید. یک عنوان بگذارید و «ساختن فهرست» را بزنید.',
        ),
      ).toExist(),
      expect(text('۰ فهرست')).toExist(),
      expect(role('button', { name: 'ساختن فهرست' })).toBeDisabled(),
    )
  })

  test('the create form submits the typed title and chosen options', () => {
    scene(
      indexScene(Lists.initialModel(), { mirror: emptyMirrorSnapshot() }),
      given(Lists.initialModel()),
      type(label('عنوان'), 'خرید هفتگی'),
      click(role('checkbox', { name: 'فقط خودم ببینم (خصوصی)' })),
      click(role('button', { name: 'رنگ #0f9d8f' })),
      click(role('button', { name: 'نماد 🏠' })),
      submit(role('form')),
      Command.expectExact(
        Lists.CreateList({
          title: 'خرید هفتگی',
          color: '#0f9d8f',
          icon: '🏠',
          sort: 'manual',
          checkedPlacement: 'bottom',
          visibility: 'private',
        }),
      ),
      Command.resolve(
        Lists.CreateList,
        Lists.Message.CompletedCreateList({
          listId: LIST_ID,
          title: 'خرید هفتگی',
        }),
      ),
      expectOutMessage(Lists.OutMessage.CreatedList({ listId: LIST_ID })),
      expect(label('عنوان')).toHaveValue(''),
    )
  })

  test('cards show open/checked counts, the preview, privacy and pending state', () => {
    const inputs = listInputs({
      mirror: mirrorWith(
        [listRow({ hasSyncError: true }), checkedListRow()],
        [listItemRow(), checkedItemRow()],
      ),
      pendingKeys: [`list\u0000${SECOND_LIST_ID}`],
    })

    scene(
      indexScene(Lists.initialModel(), inputs),
      given(Lists.initialModel()),
      expect(text('۲ فهرست')).toExist(),
      expect(text('خرید هفتگی')).toExist(),
      expect(text('۱ باز · ۱ انجام‌شده')).toExist(),
      expect(text('نان')).toExist(),
      expect(text('۰ باز · ۰ انجام‌شده · خصوصی')).toExist(),
      expect(text('در انتظار ارسال')).toExist(),
      expect(role('button', { name: 'حذف فهرست خرید هفتگی' })).toExist(),
    )
  })

  test('the offline hint and pending count explain the queued writes', () => {
    scene(
      indexScene(Lists.initialModel(), {
        isOnline: false,
        pending: 3,
      }),
      given(Lists.initialModel()),
      expect(
        text(
          'آفلاین هستید: ساخت فهرست و افزودن مورد کار می‌کند و بعداً همگام می‌شود.',
        ),
      ).toExist(),
      expect(text('۳ تغییر در صف همگام‌سازی است.')).toExist(),
    )
  })

  test('deleting a card asks for confirmation first', () => {
    scene(
      indexScene(Lists.initialModel()),
      given(Lists.initialModel()),
      click(role('button', { name: 'حذف فهرست خرید هفتگی' })),
      Command.expectExact(
        Lists.ConfirmListDelete({
          listId: LIST_ID,
          title: 'خرید هفتگی',
          scope: 'index',
        }),
      ),
      Command.resolve(
        Lists.ConfirmListDelete,
        Lists.Message.CompletedConfirmListDelete({
          listId: LIST_ID,
          isConfirmed: false,
        }),
      ),
    )
  })
})

describe('List detail', () => {
  test('renders the title, counts and checked-at-bottom order', () => {
    scene(
      detailScene(detailModel(), withItems()),
      given(detailModel()),
      expect(label('عنوان فهرست')).toHaveValue('خرید هفتگی'),
      expect(text('۳ مورد · ۱ انجام‌شده')).toExist(),
      expect(role('checkbox', { name: 'تیک زدن نان' })).toExist(),
      expect(role('checkbox', { name: 'برداشتن تیک شیر' })).toExist(),
      expect(nth(all.selector('.lists-item'), 0)).toContainText('نان'),
      expect(nth(all.selector('.lists-item'), 1)).toContainText('پنیر'),
      expect(nth(all.selector('.lists-item'), 2)).toContainText('شیر'),
      expect(
        text(
          'برای جابه‌جایی دستی، از دکمه‌های ↑/↓ استفاده کنید؛ روی صفحه‌های بزرگ می‌توانید ردیف را بکشید.',
        ),
      ).toExist(),
    )
  })

  test('the placement preference keeps checked rows in place', () => {
    const inputs = withItems({
      mirror: mirrorWith(
        [listRow({ checkedPlacement: 'inPlace' })],
        [listItemRow(), checkedItemRow(), thirdItemRow()],
      ),
    })

    scene(
      detailScene(detailModel(), inputs),
      given(detailModel()),
      expect(nth(all.selector('.lists-item'), 0)).toContainText('نان'),
      expect(nth(all.selector('.lists-item'), 1)).toContainText('شیر'),
      expect(nth(all.selector('.lists-item'), 2)).toContainText('پنیر'),
    )
  })

  test('checking a row queues the write and shows the undo toast', () => {
    scene(
      detailScene(detailModel(), withItems()),
      given(detailModel()),
      click(role('checkbox', { name: 'تیک زدن نان' })),
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
      expect(text('تیک خورد: نان')).toExist(),
      Command.resolve(
        Lists.WaitBeforeDismissToast,
        Lists.Message.CompletedWaitBeforeDismissToast({
          itemId: ITEM_ID,
          generation: 1,
        }),
      ),
      expect(text('تیک خورد: نان')).toBeAbsent(),
    )
  })

  test('the undo button restores the checked row', () => {
    const model = modifyFields(detailModel(), {
      maybeToast: () => Option.some({ id: ITEM_ID, name: 'نان' }),
    })

    scene(
      detailScene(model, withItems()),
      given(model),
      expect(text('تیک خورد: نان')).toExist(),
      click(role('button', { name: 'بازگرداندن' })),
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
      expectOutMessage(Lists.OutMessage.WroteLocalData()),
    )
  })

  test('continuous entry submits the typed name and keeps the field mounted', () => {
    scene(
      detailScene(detailModel(), withItems()),
      given(detailModel()),
      type(label('نام مورد تازه'), 'ماست'),
      submit(within(role('region', { name: 'افزودن مورد' }), role('form'))),
      Command.expectExact(
        Lists.CreateListItem({
          listId: LIST_ID,
          name: 'ماست',
          order: 4,
          visibility: 'shared',
        }),
      ),
      Command.resolve(
        Lists.CreateListItem,
        Lists.Message.CompletedCreateListItem({
          listId: LIST_ID,
          itemId: CHECKED_ITEM_ID,
          name: 'ماست',
        }),
      ),
      expectOutMessage(Lists.OutMessage.WroteLocalData()),
      expect(label('نام مورد تازه')).toHaveValue(''),
    )
  })

  test('the sort and placement pickers write their fields', () => {
    scene(
      detailScene(detailModel(), withItems()),
      given(detailModel()),
      click(role('button', { name: 'مرتب‌سازی' })),
      Mount.resolve(
        Listbox.AnchorListbox,
        Listbox.Message.CompletedAnchorListbox(),
      ),
      Mount.resolve(
        Listbox.PortalListboxBackdrop,
        Listbox.Message.CompletedPortalListboxBackdrop(),
      ),
      Command.resolve(Listbox.FocusItems, Listbox.Message.CompletedFocusItems()),
      click(text('الفبا')),
      Command.resolve(
        Listbox.FocusButton,
        Listbox.Message.CompletedFocusButton(),
      ),
      Mount.expectEnded(Listbox.AnchorListbox),
      Mount.expectEnded(Listbox.PortalListboxBackdrop),
      Command.expectExact(
        Lists.SetListSort({ listId: LIST_ID, sort: 'alpha', revision: 1 }),
      ),
      Command.resolve(
        Lists.SetListSort,
        Lists.Message.CompletedSetListSort({ listId: LIST_ID }),
      ),
      click(role('button', { name: 'جای موارد تیک‌خورده' })),
      Mount.resolve(
        Listbox.AnchorListbox,
        Listbox.Message.CompletedAnchorListbox(),
      ),
      Mount.resolve(
        Listbox.PortalListboxBackdrop,
        Listbox.Message.CompletedPortalListboxBackdrop(),
      ),
      Command.resolve(Listbox.FocusItems, Listbox.Message.CompletedFocusItems()),
      click(text('همان‌جا')),
      Command.resolve(
        Listbox.FocusButton,
        Listbox.Message.CompletedFocusButton(),
      ),
      Mount.expectEnded(Listbox.AnchorListbox),
      Mount.expectEnded(Listbox.PortalListboxBackdrop),
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
    )
  })

  test('the visibility picker is disabled for a non-owner', () => {
    scene(
      detailScene(detailModel(), {
        ...withItems(),
        maybeUserId: Option.some('someone-else'),
      }),
      given(detailModel()),
      expect(role('button', { name: 'دسترسی' })).toBeDisabled(),
    )
  })

  test('a private list carries the marker and the pending badge', () => {
    const inputs = listInputs({
      mirror: mirrorWith([listRow({ visibility: 'private' })], [listItemRow()]),
      pendingKeys: [`list\u{0}${LIST_ID}`],
    })

    scene(
      detailScene(detailModel(), inputs),
      given(detailModel()),
      expect(text('خصوصی')).toExist(),
      expect(text('در انتظار ارسال')).toExist(),
    )
  })

  test('the other member edit shows the updated-by label', () => {
    const inputs = listInputs({
      mirror: mirrorWith(
        [listRow()],
        [
          listItemRow({
            version: 3,
            lastWriterId: 'spouse',
          }),
        ],
      ),
      maybeUserId: Option.some(USER_ID),
    })

    scene(
      detailScene(detailModel(), inputs),
      given(detailModel()),
      expect(text('توسط همخانه به‌روزرسانی شد')).toExist(),
    )
  })

  test('an empty list points at the composer', () => {
    const inputs = listInputs({
      mirror: mirrorWith([listRow()], []),
    })

    scene(
      detailScene(detailModel(), inputs),
      given(detailModel()),
      expect(
        text('هنوز موردی ندارد. اولین مورد را از کادر بالا اضافه کنید.'),
      ).toExist(),
    )
  })

  test('an unread mirror shows loading instead of a false missing state', () => {
    const model = modifyFields(detailModel(), {
      isDetailLoading: () => true,
    })

    assert(model.isDetailLoading).toBe(true)

    scene(
      detailScene(model, { mirror: emptyMirrorSnapshot() }),
      given(model),
      expect(text('در حال آماده‌سازی فهرست…')).toExist(),
      expect(text('این فهرست پیدا نشد یا حذف شده است.')).toBeAbsent(),
    )
  })

  test('a missing list and a closed store have their own states', () => {
    scene(
      detailScene(detailModel(), {
        mirror: emptyMirrorSnapshot(),
      }),
      given(detailModel()),
      expect(text('این فهرست پیدا نشد یا حذف شده است.')).toExist(),
    )

    scene(
      detailScene(detailModel(), {
        ...withItems(),
        isStoreReady: false,
      }),
      given(detailModel()),
      expect(text('در حال آماده‌سازی فهرست…')).toExist(),
    )
  })

  test('an alphabetic sort hides the manual arrow buttons', () => {
    const inputs = listInputs({
      mirror: mirrorWith(
        [listRow({ sort: 'alpha' })],
        [listItemRow(), thirdItemRow()],
      ),
    })

    scene(
      detailScene(detailModel(), inputs),
      given(detailModel()),
      expect(role('button', { name: 'جابه‌جایی نان به بالا' })).toBeAbsent(),
      expect(text(/برای جابه‌جایی دستی/)).toBeAbsent(),
    )
  })

  test('a local write failure shows an alert', () => {
    const model = modifyFields(detailModel(), {
      maybeDetailError: () => Option.some('حافظه‌ی محلی پاسخ نداد'),
    })

    scene(
      detailScene(model, withItems()),
      given(model),
      expect(role('alert')).toExist(),
      expect(text('حافظه‌ی محلی پاسخ نداد')).toExist(),
    )
  })

  test('the row actions carry the item name for assistive tech', () => {
    scene(
      detailScene(detailModel(), withItems()),
      given(detailModel()),
      expect(role('button', { name: 'جابه‌جایی نان به بالا' })).toExist(),
      expect(role('button', { name: 'جابه‌جایی نان به پایین' })).toExist(),
      expect(role('button', { name: 'حذف نان' })).toExist(),
      expect(role('button', { name: 'حذف فهرست' })).toExist(),
    )
  })

  test('the back link returns to the index route', () => {
    scene(
      detailScene(detailModel(), withItems()),
      given(detailModel()),
      expect(role('link', { name: '→ همه‌ی فهرست‌ها' })).toExist(),
    )
  })
})
