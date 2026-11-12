import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Checkbox, Listbox } from '@foldkit/ui'
import { localizeDigits } from '@tali/domain'

import {
  type ListItemRow,
  type ListRow,
  UPDATED_BY_OTHER_LABEL,
  buildListItemsView,
  findListRow,
  listItemsFor,
  pendingIdsOf,
  writtenByOther,
} from '../lists-model'
import { listsRouter } from '../route'
import { buttonView } from '../ui/button'
import { confirmDialogView } from '../ui/confirm'
import { emptyStateView } from '../ui/feedback'
import { inputControlView } from '../ui/field'
import { formErrorView } from '../ui/field'
import { listboxViewInputs } from '../ui/listbox'
import { toastStackView } from '../ui/toast'
import {
  Message,
  PlacementListbox,
  SortListbox,
  VisibilityListbox,
  confirmSpec,
} from './lists'
import type {
  Model,
  PlacementOption,
  SortOption,
  ViewInputs,
  VisibilityOption,
} from './lists'

/**
 * `/lists/[id]` detail view, ported from
 * `apps/web/src/components/lists/list-detail.tsx`.
 *
 * Continuous entry keeps the input mounted across Enter, checking groups
 * checked items by the list's preference and offers a short undo toast. Manual
 * ordering is available as arrow buttons and drag-and-drop, so touch, keyboard
 * and pointer each have a path. All writes are local-first.
 */

const SORT_OPTIONS: ReadonlyArray<SortOption> = [
  { value: 'manual', label: 'دستی' },
  { value: 'alpha', label: 'الفبا' },
  { value: 'status', label: 'وضعیت' },
]

const PLACEMENT_OPTIONS: ReadonlyArray<PlacementOption> = [
  { value: 'bottom', label: 'انتهای فهرست' },
  { value: 'inPlace', label: 'همان‌جا' },
]

const VISIBILITY_OPTIONS: ReadonlyArray<VisibilityOption> = [
  { value: 'shared', label: 'مشترک با خانه' },
  { value: 'private', label: 'فقط خودم' },
]

const DANGER_BUTTON_CLASS =
  'inline-flex min-h-10 flex-none items-center rounded-full border border-error/35 bg-error/8 px-3 py-0.5 text-[0.78rem] font-medium text-error transition-colors hover:bg-error/12 disabled:opacity-55 sm:min-h-8'

const MINI_BUTTON_CLASS =
  'inline-flex min-h-10 min-w-10 flex-none items-center justify-center rounded-full border border-base-300 bg-base-100 px-2 py-0.5 text-[0.78rem] text-base-content/70 transition-colors hover:border-secondary hover:text-secondary sm:min-h-8 sm:min-w-8'

const backLinkView = (h: HtmlBuilder<Message>): Html =>
  h.a(
    [
      h.Class(
        'inline-flex min-h-10 flex-none items-center rounded-full border border-base-300 bg-base-100 px-3 py-0.5 text-[0.78rem] text-base-content/70 transition-colors hover:border-primary hover:text-primary sm:min-h-8',
      ),
      h.Href(listsRouter()),
    ],
    ['→ همه‌ی فهرست‌ها'],
  )

const loadingView = (h: HtmlBuilder<Message>): Html =>
  emptyStateView('در حال آماده‌سازی فهرست…', h, {
    attributes: [h.Role('status')],
  })

const missingView = (h: HtmlBuilder<Message>): Html =>
  emptyStateView('این فهرست پیدا نشد یا حذف شده است.', h, {
    attributes: [h.Role('status')],
  })

const headerView = (
  model: Model,
  list: ListRow,
  viewTotal: number,
  viewDone: number,
  isPending: boolean,
  isOwner: boolean,
  maybeUserId: Option.Option<string>,
  digits: ViewInputs['display']['digits'],
  h: HtmlBuilder<Message>,
): Html => {
  const titleValue = Option.getOrElse(model.maybeTitleDraft, () => list.title)
  const sortValue = Option.getOrElse(model.maybeSortDraft, () => list.sort)

  const placementValue = Option.getOrElse(
    model.maybePlacementDraft,
    () => list.checkedPlacement,
  )

  const visibilityValue = Option.getOrElse(
    model.maybeVisibilityDraft,
    () => list.visibility,
  )

  return h.header(
    [h.Class('panel grid grid-cols-1 gap-2 p-4 sm:p-5')],
    [
      h.div(
        [h.Class('grid min-w-0 gap-2')],
        [
          h.form(
            [
              h.Class(
                'flex min-w-0 flex-wrap items-center justify-between gap-2',
              ),
              h.OnSubmit(Message.SubmittedRenameList()),
            ],
            [
              h.label(
                [h.Class('grid min-w-0 flex-1 gap-0.5')],
                [
                  h.span(
                    [h.Class('text-[0.76rem] text-base-content/70')],
                    ['عنوان فهرست'],
                  ),
                  inputControlView(
                    {
                      id: 'list-title',
                      label: 'عنوان فهرست',
                      name: 'listTitle',
                      value: titleValue,
                      class: 'text-lg font-semibold',
                      onInput: value => Message.UpdatedTitleDraft({ value }),
                      attributes: [
                        h.Maxlength(120),
                        h.OnBlur(Message.BlurredTitleInput()),
                      ],
                    },
                    h,
                  ),
                ],
              ),
              h.div(
                [h.Class('flex flex-wrap items-center gap-1.5 self-end')],
                [
                  buttonView(
                    {
                      type: 'submit',
                      variant: 'ghost',
                      children: ['ذخیره‌ی نام'],
                      isLoading: model.isRenaming,
                    },
                    h,
                  ),
                  h.button(
                    [
                      h.Type('button'),
                      h.Class(DANGER_BUTTON_CLASS),
                      h.Disabled(model.isDeletingList),
                      h.OnClick(
                        Message.ClickedDeleteList({
                          listId: list.id,
                          title: list.title,
                          scope: 'detail',
                        }),
                      ),
                    ],
                    ['حذف فهرست'],
                  ),
                ],
              ),
            ],
          ),
          h.div(
            [
              h.Class(
                'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.72rem] text-base-content/70',
              ),
              h.AriaLive('polite'),
            ],
            [
              h.span(
                [],
                [
                  `${localizeDigits(viewTotal, digits)} مورد · ${localizeDigits(
                    viewDone,
                    digits,
                  )} انجام‌شده`,
                ],
              ),
              list.visibility === 'private' ? h.span([], ['خصوصی']) : h.empty,
              isPending
                ? h.span([h.Class('text-warning')], ['در انتظار ارسال'])
                : h.empty,
              list.hasSyncError
                ? h.span([h.Class('text-error')], ['خطا در همگام‌سازی'])
                : h.empty,
              writtenByOther(list.lastWriterId, maybeUserId, list.version)
                ? h.span([], [UPDATED_BY_OTHER_LABEL])
                : h.empty,
            ],
          ),
          h.div(
            [h.Class('grid gap-3 sm:grid-cols-3')],
            [
              h.div(
                [h.Class('grid gap-1.5')],
                [
                  h.label(
                    [
                      h.For(Listbox.buttonId(model.sortListbox.id)),
                      h.Class('text-sm font-medium text-base-content/70'),
                    ],
                    ['مرتب‌سازی'],
                  ),
                  h.submodel({
                    slotId: model.sortListbox.id,
                    model: model.sortListbox,
                    view: SortListbox.view,
                    viewInputs: listboxViewInputs({
                      items: SORT_OPTIONS,
                      maybeSelectedValue: Option.some(sortValue),
                      h,
                    }),
                    toParentMessage: message =>
                      Message.GotSortListboxMessage({ message }),
                  }),
                ],
              ),
              h.div(
                [h.Class('grid gap-1.5')],
                [
                  h.label(
                    [
                      h.For(Listbox.buttonId(model.placementListbox.id)),
                      h.Class('text-sm font-medium text-base-content/70'),
                    ],
                    ['جای موارد تیک‌خورده'],
                  ),
                  h.submodel({
                    slotId: model.placementListbox.id,
                    model: model.placementListbox,
                    view: PlacementListbox.view,
                    viewInputs: listboxViewInputs({
                      items: PLACEMENT_OPTIONS,
                      maybeSelectedValue: Option.some(placementValue),
                      h,
                    }),
                    toParentMessage: message =>
                      Message.GotPlacementListboxMessage({ message }),
                  }),
                ],
              ),
              h.div(
                [h.Class('grid gap-1.5')],
                [
                  h.label(
                    [
                      h.For(Listbox.buttonId(model.visibilityListbox.id)),
                      h.Class('text-sm font-medium text-base-content/70'),
                    ],
                    ['دسترسی'],
                  ),
                  h.submodel({
                    slotId: model.visibilityListbox.id,
                    model: model.visibilityListbox,
                    view: VisibilityListbox.view,
                    viewInputs: listboxViewInputs({
                      items: VISIBILITY_OPTIONS,
                      maybeSelectedValue: Option.some(visibilityValue),
                      isDisabled: !isOwner,
                      h,
                    }),
                    toParentMessage: message =>
                      Message.GotVisibilityListboxMessage({ message }),
                  }),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

const addItemSectionView = (
  model: Model,
  isStoreReady: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.Class('panel grid grid-cols-1 gap-2 p-4 sm:p-5'),
      h.AriaLabelledBy('lists-entry-title'),
    ],
    [
      h.h2(
        [h.Id('lists-entry-title'), h.Class('m-0 text-lg font-bold')],
        ['افزودن مورد'],
      ),
      h.form(
        [
          h.Class('flex min-w-0 items-center gap-2'),
          h.OnSubmit(Message.SubmittedAddItem()),
        ],
        [
          inputControlView(
            {
              id: 'lists-item-draft',
              label: 'نام مورد تازه',
              name: 'itemName',
              value: model.itemDraft,
              placeholder: 'مورد تازه… (Enter برای مورد بعد)',
              autoComplete: 'off',
              isDisabled: !isStoreReady,
              class: 'min-w-0 flex-1',
              onInput: value => Message.UpdatedItemDraft({ value }),
              attributes: [h.Maxlength(200)],
            },
            h,
          ),
          buttonView(
            {
              type: 'submit',
              isDisabled:
                !isStoreReady ||
                model.isAddingItem ||
                model.itemDraft.trim() === '',
              children: ['افزودن'],
            },
            h,
          ),
        ],
      ),
      h.p(
        [h.Class('soft-note m-0')],
        [
          'تایپ کنید و Enter بزنید؛ نشانگر در همین کادر می‌ماند تا مورد بعدی را بنویسید.',
        ],
      ),
    ],
  )

const itemRowView = (
  model: Model,
  item: ListItemRow,
  isManual: boolean,
  isItemPending: boolean,
  canToggle: boolean,
  maybeUserId: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html => {
  const isDragging = Option.contains(model.maybeDraggingId, item.id)
  const isDragOver = Option.contains(model.maybeDragOverId, item.id)

  return Checkbox.view(
    {
      id: `lists-check-${item.id}`,
      isChecked: item.done,
      onToggle: () => Message.ClickedToggleItem({ itemId: item.id }),
      toView: attributes =>
        h.keyed('li')(
          item.id,
          [
            h.Class(
              'group flex min-w-0 items-start gap-2.5 px-4 py-3 transition-colors hover:bg-base-content/[0.03] data-[dragging=true]:opacity-45 data-[over=true]:bg-primary/6 data-[over=true]:ring-2 data-[over=true]:ring-primary/40 data-[over=true]:ring-inset',
            ),
            h.DataAttribute('done', item.done ? 'true' : 'false'),
            h.DataAttribute('dragging', isDragging ? 'true' : 'false'),
            h.DataAttribute('over', isDragOver ? 'true' : 'false'),
            h.Draggable(isManual),
            h.OnDragStart(Message.StartedDraggingItem({ itemId: item.id })),
            h.OnDragOver(Message.EnteredDragTarget({ itemId: item.id })),
            h.OnDragLeave(Message.LeftDragTarget({ itemId: item.id })),
            h.OnDrop(Message.DroppedOnItem({ itemId: item.id })),
            h.OnDragEnd(Message.EndedDragItem()),
          ],
          [
            h.button(
              [
                ...attributes.checkbox,
                h.Class(
                  'relative grid size-6 flex-none place-items-center rounded-full border-[1.5px] border-base-300 bg-base-100 text-[0.72rem] text-transparent transition-colors before:absolute before:-inset-2 before:content-[""] enabled:hover:border-secondary enabled:active:scale-90 aria-checked:border-secondary aria-checked:bg-secondary aria-checked:text-secondary-content disabled:opacity-55',
                ),
                h.Disabled(!canToggle),
              ],
              [item.done ? '✓' : ''],
            ),
            h.div(
              [h.Class('grid min-w-0 flex-1 gap-0.5')],
              [
                h.span(
                  [
                    ...attributes.label,
                    h.Class(
                      'relative inline-block max-w-full min-w-0 break-words leading-7 transition-colors after:absolute after:start-0 after:top-1/2 after:h-px after:w-0 after:bg-current after:transition-[width] after:duration-200 group-data-[done=true]:text-base-content/70 group-data-[done=true]:after:w-full',
                    ),
                  ],
                  [item.name],
                ),
                h.div(
                  [
                    h.Class(
                      'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.72rem] text-base-content/70',
                    ),
                  ],
                  [
                    isItemPending
                      ? h.span([h.Class('text-warning')], ['در انتظار ارسال'])
                      : h.empty,
                    item.done ? h.span([], ['انجام‌شده']) : h.empty,
                    item.hasSyncError
                      ? h.span([h.Class('text-error')], ['خطا در همگام‌سازی'])
                      : h.empty,
                    writtenByOther(item.lastWriterId, maybeUserId, item.version)
                      ? h.span([], [UPDATED_BY_OTHER_LABEL])
                      : h.empty,
                  ],
                ),
              ],
            ),
            h.div(
              [
                h.Class(
                  'flex flex-none flex-wrap items-center justify-end gap-1',
                ),
              ],
              [
                ...(isManual
                  ? [
                      h.button(
                        [
                          h.Type('button'),
                          h.Class(MINI_BUTTON_CLASS),
                          h.AriaLabel(`جابه‌جایی ${item.name} به بالا`),
                          h.Title('بالا'),
                          h.OnClick(
                            Message.ClickedMoveItem({
                              itemId: item.id,
                              direction: 'up',
                            }),
                          ),
                        ],
                        ['↑'],
                      ),
                      h.button(
                        [
                          h.Type('button'),
                          h.Class(MINI_BUTTON_CLASS),
                          h.AriaLabel(`جابه‌جایی ${item.name} به پایین`),
                          h.Title('پایین'),
                          h.OnClick(
                            Message.ClickedMoveItem({
                              itemId: item.id,
                              direction: 'down',
                            }),
                          ),
                        ],
                        ['↓'],
                      ),
                    ]
                  : []),
                h.button(
                  [
                    h.Type('button'),
                    h.Class(DANGER_BUTTON_CLASS),
                    h.AriaLabel(`حذف ${item.name}`),
                    h.OnClick(
                      Message.ClickedDeleteItem({
                        itemId: item.id,
                        name: item.name,
                      }),
                    ),
                  ],
                  ['حذف'],
                ),
              ],
            ),
          ],
        ),
    },
    h,
  )
}

const itemsView = (
  model: Model,
  inputs: ViewInputs,
  list: ListRow,
  h: HtmlBuilder<Message>,
): Html => {
  const items = listItemsFor(inputs.mirror.listItems, list.id)
  const view = buildListItemsView(list, items)
  const pendingItemIds = pendingIdsOf(inputs.pendingKeys, 'listItem')
  const isManual = list.sort === 'manual'

  return Array.match(view.visible, {
    onEmpty: () =>
      emptyStateView(
        'هنوز موردی ندارد. اولین مورد را از کادر بالا اضافه کنید.',
        h,
      ),
    onNonEmpty: rows =>
      h.div(
        [h.Class('grid gap-2')],
        [
          h.ul(
            [
              h.Class(
                'panel m-0 list-none divide-y divide-base-300 overflow-hidden p-0',
              ),
              h.AriaLabel('موارد فهرست'),
            ],
            Array.map(rows, item =>
              itemRowView(
                model,
                item,
                isManual,
                Array.contains(pendingItemIds, item.id),
                inputs.isStoreReady,
                inputs.maybeUserId,
                h,
              ),
            ),
          ),
          isManual
            ? h.p(
                [h.Class('soft-note m-0')],
                [
                  'برای جابه‌جایی دستی، از دکمه‌های ↑/↓ استفاده کنید؛ روی صفحه‌های بزرگ می‌توانید ردیف را بکشید.',
                ],
              )
            : h.empty,
        ],
      ),
  })
}

const toastView = (model: Model, h: HtmlBuilder<Message>): Html =>
  toastStackView(
    {
      model: model.toast,
      toParentMessage: message => Message.GotToastMessage({ message }),
      toUndoMessage: (entryId, undo) =>
        Message.ClickedUndoChecked({ entryId, undo }),
    },
    h,
  )

const detailBodyView = (
  model: Model,
  inputs: ViewInputs,
  list: ListRow,
  h: HtmlBuilder<Message>,
): Html => {
  const items = listItemsFor(inputs.mirror.listItems, list.id)
  const view = buildListItemsView(list, items)
  const pendingListIds = pendingIdsOf(inputs.pendingKeys, 'list')
  const pendingItemIds = pendingIdsOf(inputs.pendingKeys, 'listItem')

  const isPending =
    Array.contains(pendingListIds, list.id) ||
    Array.some(items, item => Array.contains(pendingItemIds, item.id))

  const isOwner = Option.exists(inputs.maybeUserId, id => id === list.ownerId)

  return h.div(
    [h.Class('grid min-w-0 gap-4')],
    [
      headerView(
        model,
        list,
        view.total,
        view.doneCount,
        isPending,
        isOwner,
        inputs.maybeUserId,
        inputs.display.digits,
        h,
      ),
      addItemSectionView(model, inputs.isStoreReady, h),
      formErrorView(model.maybeDetailError, h),
      itemsView(model, inputs, list, h),
    ],
  )
}

export const listDetailView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeList = Option.flatMap(model.maybeListId, listId =>
    findListRow(inputs.mirror.lists, listId),
  )

  return h.div(
    [h.Class('min-w-0 overflow-x-clip'), h.Dir('rtl'), h.Lang('fa')],
    [
      h.div(
        [h.Class('page-wrap grid w-full max-w-5xl min-w-0 grid-cols-1 gap-4')],
        [
          h.h1([h.Class('sr-only')], ['فهرست']),
          h.div([h.Class('flex flex-wrap gap-1.5')], [backLinkView(h)]),
          !inputs.isStoreReady ||
          (model.isDetailLoading && Option.isNone(maybeList))
            ? loadingView(h)
            : Option.match(maybeList, {
                onNone: () => missingView(h),
                onSome: list => detailBodyView(model, inputs, list, h),
              }),
          confirmDialogView(
            {
              model: model.confirmDialog,
              toParentMessage: message =>
                Message.GotConfirmDialogMessage({ message }),
              onConfirm: Message.ConfirmedDeleteList(),
              spec: confirmSpec(model),
            },
            h,
          ),
          toastView(model, h),
        ],
      ),
    ],
  )
}
