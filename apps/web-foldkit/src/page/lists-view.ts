import { Array } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

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
import { formErrorView } from '../ui/field'
import { Message } from './lists'
import type { Model, ViewInputs } from './lists'

/**
 * `/lists` index view, ported from `apps/web/src/components/lists/lists-screen.tsx`.
 *
 * Create a list with a title, colour and icon, then see open/checked counts and
 * a two-item preview. Everything reads the mirror, so counts are correct
 * offline; creation queues in the outbox. Layout is logical-property only and
 * every colour resolves from the active daisyUI theme.
 */

const swatchStyle = (choice: string, isSelected: boolean) => ({
  background: choice,
  border: isSelected
    ? '3px solid var(--color-base-content)'
    : '1px solid var(--color-base-300)',
  ...(isSelected
    ? { 'box-shadow': '0 0 0 2px var(--color-base-100) inset' }
    : {}),
})

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
      h.Class('lists-index-card'),
      h.DataAttribute('pending', isPending ? 'true' : 'false'),
    ],
    [
      h.a(
        [h.Class('lists-index-link'), h.Href(listPath(list.id))],
        [
          h.h3(
            [h.Class('lists-title')],
            [
              ...(list.icon === null
                ? []
                : [h.span([h.Class('lists-title-icon')], [list.icon])]),
              h.span([], [list.title]),
            ],
          ),
          h.p(
            [h.Class('lists-sub')],
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
                [h.Class('lists-preview')],
                Array.map(names, name => h.li([], [name])),
              ),
          }),
        ],
      ),
      h.div(
        [h.Class('lists-index-actions')],
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
              h.Class('lists-danger'),
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
    [h.Class('panel grid gap-3 p-5'), h.AriaLabelledBy('lists-create-title')],
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
                [h.Class('text-[0.8rem] text-base-content/55')],
                ['عنوان'],
              ),
              h.input([
                h.Name('title'),
                h.Type('text'),
                h.Class('input w-full'),
                h.Required(true),
                h.Maxlength(120),
                h.Autocomplete('off'),
                h.Placeholder('مثلاً خرید هفتگی'),
                h.Value(model.indexTitle),
                h.Disabled(model.isCreating),
                h.OnInput(value => Message.UpdatedIndexTitle({ value })),
              ]),
            ],
          ),
          h.div(
            [h.Class('grid gap-3 sm:grid-cols-2')],
            [
              h.fieldset(
                [h.Class('m-0 grid gap-1.5 border-0 p-0')],
                [
                  h.legend(
                    [h.Class('text-[0.8rem] text-base-content/55')],
                    ['رنگ'],
                  ),
                  h.div(
                    [h.Class('flex flex-wrap gap-2')],
                    Array.map(COLOR_CHOICES, choice =>
                      h.button([
                        h.Type('button'),
                        h.Class('lists-swatch'),
                        h.AriaLabel(`رنگ ${choice}`),
                        h.AriaPressed(
                          model.indexColor === choice ? 'true' : 'false',
                        ),
                        h.Style(
                          swatchStyle(choice, model.indexColor === choice),
                        ),
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
                    [h.Class('text-[0.8rem] text-base-content/55')],
                    ['نماد'],
                  ),
                  h.div(
                    [h.Class('flex flex-wrap gap-1.5')],
                    Array.map(ICON_CHOICES, choice =>
                      h.button(
                        [
                          h.Type('button'),
                          h.Class('lists-icon-choice'),
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
          h.label(
            [h.Class('flex items-center gap-2 text-sm')],
            [
              h.input([
                h.Type('checkbox'),
                h.Class('checkbox checkbox-primary checkbox-sm'),
                h.AriaLabel('فقط خودم ببینم (خصوصی)'),
                h.Checked(model.indexVisibility === 'private'),
                h.OnClick(
                  Message.ToggledIndexVisibility({
                    isPrivate: model.indexVisibility !== 'private',
                  }),
                ),
              ]),
              'فقط خودم ببینم (خصوصی)',
            ],
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
        [h.Class('lists-sr'), h.Role('status'), h.AriaLive('polite')],
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
    [h.Class('grid gap-2'), h.AriaLabelledBy('lists-all-title')],
    [
      h.div(
        [h.Class('flex flex-wrap items-baseline justify-between gap-2')],
        [
          h.h2(
            [h.Id('lists-all-title'), h.Class('m-0 text-xl font-bold')],
            ['همه‌ی فهرست‌ها'],
          ),
          h.span(
            [h.Class('text-[0.8rem] text-base-content/50')],
            [`${localizeDigits(summaries.length, digits)} فهرست`],
          ),
        ],
      ),
      Array.match(summaries, {
        onEmpty: () =>
          h.p(
            [h.Class('lists-empty panel p-5')],
            [
              'هنوز فهرستی نساخته‌اید. یک عنوان بگذارید و «ساختن فهرست» را بزنید.',
            ],
          ),
        onNonEmpty: entries =>
          h.div(
            [h.Class('lists-index-grid')],
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
    [h.Class('lists-root'), h.Dir('rtl'), h.Lang('fa')],
    [
      h.div(
        [h.Class('lists-screen page-wrap grid w-full max-w-5xl gap-4')],
        [
          h.header(
            [h.Class('panel grid gap-1.5 p-5')],
            [
              h.h1(
                [h.Class('m-0 text-2xl font-bold tracking-tight sm:text-3xl')],
                ['فهرست‌ها'],
              ),
              h.p(
                [h.Class('m-0 text-sm leading-7 text-base-content/55')],
                [
                  'فهرست خرید، کارهای خانه یا هر چک‌لیست مشترک. هر تغییر اول روی همین دستگاه ذخیره می‌شود.',
                ],
              ),
              inputs.isOnline
                ? h.empty
                : h.p(
                    [h.Class('lists-hint'), h.Role('status')],
                    [
                      'آفلاین هستید: ساخت فهرست و افزودن مورد کار می‌کند و بعداً همگام می‌شود.',
                    ],
                  ),
              inputs.pending > 0
                ? h.p(
                    [
                      h.Role('status'),
                      h.AriaLive('polite'),
                      h.Class('m-0 text-[0.78rem] text-base-content/50'),
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
        ],
      ),
    ],
  )
}
