import { Array } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Checkbox } from '@foldkit/ui'
import { localizeDigits } from '@tali/domain'

import {
  COLOR_CHOICES,
  ICON_CHOICES,
  type ListSummary,
  listItemsFor,
  listSummaries,
  pendingIdsOf,
} from '../lists-model'
import { listPath } from '../route'
import { buttonView } from '../ui/button'
import { confirmDialogView } from '../ui/confirm'
import { formErrorView, inputControlView } from '../ui/field'
import { toastStackView } from '../ui/toast'
import { Message, confirmSpec } from './lists'
import type { Model, ViewInputs } from './lists'

/**
 * `/lists` index view, ported from `apps/web/src/components/lists/lists-screen.tsx`.
 *
 * Create a list with a title, colour and icon, then see open/checked counts and
 * a two-item preview. Everything reads the mirror, so counts are correct
 * offline; creation queues in the outbox. Layout is logical-property only and
 * every colour resolves from the active theme.
 */

const SWATCH_CLASS =
  'size-9 flex-none cursor-pointer rounded-full p-0 ring-1 ring-base-300 ring-inset transition-shadow aria-pressed:ring-2 aria-pressed:ring-base-content'

const ICON_CHOICE_CLASS =
  'inline-flex size-10 flex-none items-center justify-center rounded-full border border-base-300 bg-base-100 p-0 text-[1.05rem] text-base-content/70 transition-colors hover:border-base-content/25 data-[active=true]:border-primary data-[active=true]:bg-primary/10 data-[active=true]:text-primary'

const DANGER_BUTTON_CLASS =
  'inline-flex min-h-10 flex-none items-center rounded-full border border-error/35 bg-error/8 px-3 py-0.5 text-[0.78rem] font-medium text-error transition-colors hover:bg-error/12 disabled:opacity-55 sm:min-h-8'

const EMPTY_STATE_CLASS =
  'm-0 rounded-2xl border border-dashed border-base-300 px-6 py-10 text-center text-sm leading-7 text-base-content/70'

const listCardView = (
  entry: ListSummary,
  isPending: boolean,
  hasSyncError: boolean,
  digits: ViewInputs['display']['digits'],
  h: HtmlBuilder<Message>,
): Html => {
  const list = entry.list

  return h.keyed('article')(
    list.id,
    [
      h.Class(
        'grid min-w-0 gap-2 rounded-2xl border border-base-300 bg-base-100 p-4 shadow-panel transition-colors data-[pending=true]:border-warning/40 data-[pending=true]:bg-warning/6',
      ),
      h.DataAttribute('pending', isPending ? 'true' : 'false'),
    ],
    [
      h.a(
        [
          h.Class('group grid min-w-0 cursor-pointer gap-1 rounded-xl'),
          h.Href(listPath(list.id)),
        ],
        [
          h.h3(
            [h.Class('m-0 flex min-w-0 items-center gap-2')],
            [
              ...(list.icon === null
                ? []
                : [h.span([h.Class('shrink-0')], [list.icon])]),
              h.span(
                [
                  h.Class(
                    'min-w-0 text-[1.02rem] leading-7 font-semibold break-words transition-colors group-hover:text-primary group-hover:underline group-hover:underline-offset-4',
                  ),
                ],
                [list.title],
              ),
            ],
          ),
          h.p(
            [
              h.Class(
                'm-0 text-[0.8rem] leading-6 break-words text-base-content/70',
              ),
            ],
            [
              `${localizeDigits(entry.open, digits)} باز · ${localizeDigits(
                entry.done,
                digits,
              )} انجام‌شده${list.visibility === 'private' ? ' · خصوصی' : ''}`,
            ],
          ),
          Array.match(entry.preview, {
            onEmpty: () => h.empty,
            onNonEmpty: names =>
              h.ul(
                [
                  h.Class(
                    'm-0 list-disc ps-[1.1em] text-[0.8rem] leading-6 text-base-content/70',
                  ),
                ],
                Array.map(names, name =>
                  h.li([h.Class('break-words')], [name]),
                ),
              ),
          }),
        ],
      ),
      h.div(
        [h.Class('flex flex-wrap items-center justify-end gap-1.5')],
        [
          isPending
            ? h.span(
                [h.Class('badge badge-warning badge-sm')],
                ['در انتظار ارسال'],
              )
            : h.empty,
          hasSyncError
            ? h.span(
                [h.Class('badge badge-error badge-sm')],
                ['خطا در همگام‌سازی'],
              )
            : h.empty,
          h.button(
            [
              h.Type('button'),
              h.Class(DANGER_BUTTON_CLASS),
              h.AriaLabel(`حذف فهرست ${list.title}`),
              h.OnClick(
                Message.ClickedDeleteList({
                  listId: list.id,
                  title: list.title,
                  scope: 'index',
                }),
              ),
            ],
            ['حذف'],
          ),
        ],
      ),
    ],
  )
}

const createSectionView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.Class('panel grid grid-cols-1 gap-3 p-4 sm:p-5'),
      h.AriaLabelledBy('lists-create-title'),
    ],
    [
      h.h2(
        [h.Id('lists-create-title'), h.Class('m-0 text-lg font-bold')],
        ['فهرست تازه'],
      ),
      h.form(
        [h.Class('grid gap-3'), h.OnSubmit(Message.SubmittedCreateList())],
        [
          h.label(
            [h.Class('grid gap-1')],
            [
              h.span(
                [h.Class('text-[0.8rem] text-base-content/70')],
                ['عنوان'],
              ),
              inputControlView(
                {
                  id: 'lists-title',
                  label: 'عنوان',
                  name: 'title',
                  value: model.indexTitle,
                  placeholder: 'مثلاً خرید هفتگی',
                  autoComplete: 'off',
                  isDisabled: model.isCreating,
                  isRequired: true,
                  onInput: value => Message.UpdatedIndexTitle({ value }),
                  attributes: [h.Maxlength(120)],
                },
                h,
              ),
            ],
          ),
          h.div(
            [h.Class('grid gap-3 sm:grid-cols-2')],
            [
              h.fieldset(
                [h.Class('m-0 grid gap-1.5 border-0 p-0')],
                [
                  h.legend(
                    [h.Class('text-[0.8rem] text-base-content/70')],
                    ['رنگ'],
                  ),
                  h.div(
                    [h.Class('flex flex-wrap gap-2')],
                    Array.map(COLOR_CHOICES, choice =>
                      h.button([
                        h.Type('button'),
                        h.Class(SWATCH_CLASS),
                        h.AriaLabel(`رنگ ${choice}`),
                        h.AriaPressed(
                          model.indexColor === choice ? 'true' : 'false',
                        ),
                        h.Style({ background: choice }),
                        h.OnClick(
                          Message.SelectedIndexColor({ color: choice }),
                        ),
                      ]),
                    ),
                  ),
                ],
              ),
              h.fieldset(
                [h.Class('m-0 grid gap-1.5 border-0 p-0')],
                [
                  h.legend(
                    [h.Class('text-[0.8rem] text-base-content/70')],
                    ['نماد'],
                  ),
                  h.div(
                    [h.Class('flex flex-wrap gap-1.5')],
                    Array.map(ICON_CHOICES, choice =>
                      h.button(
                        [
                          h.Type('button'),
                          h.Class(ICON_CHOICE_CLASS),
                          h.AriaLabel(`نماد ${choice}`),
                          h.AriaPressed(
                            model.indexIcon === choice ? 'true' : 'false',
                          ),
                          h.DataAttribute(
                            'active',
                            model.indexIcon === choice ? 'true' : 'false',
                          ),
                          h.OnClick(
                            Message.SelectedIndexIcon({ icon: choice }),
                          ),
                        ],
                        [choice],
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
          Checkbox.view(
            {
              id: 'lists-private-check',
              isChecked: model.indexVisibility === 'private',
              onToggle: isChecked =>
                Message.ToggledIndexVisibility({ isPrivate: isChecked }),
              toView: attributes =>
                h.div(
                  [h.Class('flex items-center gap-2 text-sm')],
                  [
                    h.button([...attributes.checkbox, h.Class('form-check')]),
                    h.span([...attributes.label], ['فقط خودم ببینم (خصوصی)']),
                  ],
                ),
            },
            h,
          ),
          formErrorView(model.maybeIndexError, h),
          h.div(
            [h.Class('flex justify-end')],
            [
              buttonView(
                {
                  type: 'submit',
                  isDisabled:
                    model.isCreating || model.indexTitle.trim() === '',
                  isLoading: model.isCreating,
                  children: ['ساختن فهرست'],
                },
                h,
              ),
            ],
          ),
        ],
      ),
      h.p(
        [h.Class('sr-only'), h.Role('status'), h.AriaLive('polite')],
        [model.announcement],
      ),
    ],
  )

const allListsSectionView = (
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const summaries = listSummaries(inputs.mirror.lists, inputs.mirror.listItems)
  const pendingListIds = pendingIdsOf(inputs.pendingKeys, 'list')
  const pendingItemIds = pendingIdsOf(inputs.pendingKeys, 'listItem')
  const digits = inputs.display.digits

  const listItems = (entry: ListSummary) =>
    listItemsFor(inputs.mirror.listItems, entry.list.id)

  const isPending = (entry: ListSummary): boolean =>
    Array.contains(pendingListIds, entry.list.id) ||
    Array.some(listItems(entry), item =>
      Array.contains(pendingItemIds, item.id),
    )

  const hasSyncError = (entry: ListSummary): boolean =>
    entry.list.hasSyncError ||
    Array.some(listItems(entry), item => item.hasSyncError)

  return h.section(
    [h.Class('grid gap-3'), h.AriaLabelledBy('lists-all-title')],
    [
      h.div(
        [h.Class('flex flex-wrap items-baseline justify-between gap-2')],
        [
          h.h2(
            [h.Id('lists-all-title'), h.Class('m-0 text-lg font-bold')],
            ['همه‌ی فهرست‌ها'],
          ),
          h.span(
            [h.Class('text-[0.8rem] text-base-content/70')],
            [`${localizeDigits(summaries.length, digits)} فهرست`],
          ),
        ],
      ),
      Array.match(summaries, {
        onEmpty: () =>
          h.p(
            [h.Class(EMPTY_STATE_CLASS)],
            [
              'هنوز فهرستی نساخته‌اید. یک عنوان بگذارید و «ساختن فهرست» را بزنید.',
            ],
          ),
        onNonEmpty: entries =>
          h.div(
            [h.Class('grid min-w-0 gap-3 sm:grid-cols-2')],
            Array.map(entries, entry =>
              listCardView(
                entry,
                isPending(entry),
                hasSyncError(entry),
                digits,
                h,
              ),
            ),
          ),
      }),
    ],
  )
}

export const listsIndexView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits

  return h.div(
    [h.Class('min-w-0 overflow-x-clip'), h.Dir('rtl'), h.Lang('fa')],
    [
      h.div(
        [h.Class('page-wrap grid w-full max-w-5xl min-w-0 grid-cols-1 gap-4')],
        [
          h.header(
            [h.Class('grid gap-1.5')],
            [
              h.h1(
                [h.Class('m-0 text-2xl font-bold tracking-tight sm:text-3xl')],
                ['فهرست‌ها'],
              ),
              h.p(
                [h.Class('m-0 text-sm leading-7 text-base-content/70')],
                [
                  'فهرست خرید، کارهای خانه یا هر چک‌لیست مشترک. هر تغییر اول روی همین دستگاه ذخیره می‌شود.',
                ],
              ),
              inputs.isOnline
                ? h.empty
                : h.p(
                    [h.Class('notice notice-warning m-0'), h.Role('status')],
                    [
                      'آفلاین هستید: ساخت فهرست و افزودن مورد کار می‌کند و بعداً همگام می‌شود.',
                    ],
                  ),
              inputs.pending > 0
                ? h.p(
                    [
                      h.Role('status'),
                      h.AriaLive('polite'),
                      h.Class('m-0 text-[0.78rem] text-base-content/70'),
                    ],
                    [
                      `${localizeDigits(
                        inputs.pending,
                        digits,
                      )} تغییر در صف همگام‌سازی است.`,
                    ],
                  )
                : h.empty,
            ],
          ),
          createSectionView(model, h),
          allListsSectionView(inputs, h),
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
          toastStackView(
            {
              model: model.toast,
              toParentMessage: message => Message.GotToastMessage({ message }),
              toUndoMessage: (entryId, undo) =>
                Message.ClickedUndoChecked({ entryId, undo }),
            },
            h,
          ),
        ],
      ),
    ],
  )
}
