import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { syncFailureMessage } from '../lib/sync-copy'
import { shareActionOf } from '../lib/visibility-writes'
import { notesRouter, notesTrashRouter } from '../route'
import { buttonView } from '../ui/button'
import {
  formErrorView,
  inputControlView,
  textAreaControlView,
} from '../ui/field'
import { archiveIcon, pinIcon, trashIcon } from '../ui/icons'
import { Message } from './notes'
import type { Model, ViewInputs } from './notes'

/**
 * `/notes/[id]` view, ported from `apps/web/src/routes/notes/[id].tsx`.
 *
 * The editor renders loading/missing/ready, disables editing for a trashed
 * note, and surfaces a durable sync rejection with its retry action. Status
 * copy distinguishes local save from server acknowledgement.
 */

const statusText = (model: Model, inputs: ViewInputs): string => {
  if (model.saveState === 'error') {
    return 'ذخیره نشد؛ دوباره تلاش می‌شود.'
  }

  if (model.saveState === 'saving') {
    return 'در حال ذخیره…'
  }

  if (Option.isSome(model.maybeSyncError)) {
    return 'ذخیره نشد؛ روی سرور اعمال نشد'
  }

  if (inputs.pending > 0) {
    return 'ذخیره شد؛ در انتظار همگام‌سازی'
  }

  return 'ذخیره شد'
}

const statusView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const hasError =
    model.saveState === 'error' || Option.isSome(model.maybeSyncError)

  return h.span(
    [
      h.Role('status'),
      h.AriaLive('polite'),
      h.Class(
        hasError
          ? 'badge badge-error badge-sm h-7 gap-1.5'
          : 'badge badge-ghost badge-sm h-7 gap-1.5',
      ),
    ],
    [
      model.saveState === 'saving'
        ? h.span([h.Class('spinner spinner-xs')])
        : h.span([h.Class('size-1.5 rounded-full bg-current opacity-60')]),
      model.loadState === 'ready' ? statusText(model, inputs) : '',
    ],
  )
}

const missingView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('panel grid grid-cols-1 gap-3 p-4 sm:p-5')],
    [
      h.p(
        [h.Class('m-0 text-sm leading-8')],
        [Option.getOrElse(model.maybeLoadHint, () => 'این یادداشت پیدا نشد.')],
      ),
      h.div(
        [],
        [h.a([h.Href(notesRouter()), h.Class('btn btn-ghost')], ['بازگشت'])],
      ),
    ],
  )

const tagsView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(inputs.mirror.tags, {
    onEmpty: () => h.empty,
    onNonEmpty: tags =>
      h.div(
        [
          h.Class('flex flex-wrap items-center gap-1.5'),
          h.AriaLabel('برچسب‌ها'),
        ],
        Array.map(tags, tag => {
          const isSelected = Array.contains(model.tagIds, tag.id)

          return h.button(
            [
              h.Type('button'),
              h.Class(
                isSelected
                  ? 'badge badge-primary min-h-10 cursor-pointer'
                  : 'badge badge-ghost min-h-10 cursor-pointer',
              ),
              h.AriaPressed(isSelected ? 'true' : 'false'),
              h.Disabled(model.isTrashed),
              h.OnClick(Message.ClickedToggleEditorTag({ tagId: tag.id })),
            ],
            [tag.name],
          )
        }),
      ),
  })

const trashedAlertView = (model: Model, h: HtmlBuilder<Message>): Html =>
  model.isTrashed
    ? h.section(
        [h.Class('notice notice-warning m-0 items-start')],
        [
          h.div(
            [h.Class('grid gap-2')],
            [
              h.p(
                [h.Class('m-0 font-medium')],
                ['این یادداشت در سطل زباله است.'],
              ),
              h.div(
                [h.Class('flex flex-wrap items-center gap-2')],
                [
                  buttonView(
                    {
                      type: 'button',
                      isDisabled: model.isRestoring,
                      isLoading: model.isRestoring,
                      onClick: Message.ClickedRestoreNote(),
                      children: [
                        model.isRestoring ? 'در حال بازگردانی…' : 'بازگردانی',
                      ],
                    },
                    h,
                  ),
                  h.a(
                    [h.Href(notesTrashRouter()), h.Class('btn btn-ghost')],
                    ['سطل زباله'],
                  ),
                ],
              ),
            ],
          ),
        ],
      )
    : h.empty

const syncErrorView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeSyncError, {
    onNone: () => h.empty,
    onSome: code =>
      h.section(
        [h.Role('alert'), h.Class('notice notice-error m-0 items-start')],
        [
          h.div(
            [h.Class('grid gap-2')],
            [
              h.p([h.Class('m-0 leading-8')], [syncFailureMessage(code)]),
              h.p(
                [h.Class('m-0 text-[0.82rem] opacity-80')],
                ['این یادداشت فعلاً فقط روی این دستگاه ذخیره شده است.'],
              ),
              h.div(
                [],
                [
                  buttonView(
                    {
                      type: 'button',
                      isDisabled: model.isRetrying,
                      isLoading: model.isRetrying,
                      onClick: Message.ClickedRetrySync(),
                      children: [
                        model.isRetrying ? 'در حال تلاش…' : 'تلاش دوباره',
                      ],
                    },
                    h,
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
  })

const editorFormView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class('panel grid grid-cols-1 gap-4 p-4 sm:p-5')],
    [
      h.label(
        [h.For('note-title'), h.Class('grid gap-1.5')],
        [
          h.span(
            [h.Class('text-sm font-medium text-base-content/70')],
            ['عنوان'],
          ),
          inputControlView(
            {
              id: 'note-title',
              label: 'عنوان یادداشت',
              value: model.title,
              placeholder: 'بی‌عنوان',
              isDisabled: model.isTrashed,
              class: 'min-h-12 text-base font-bold',
              onInput: value => Message.UpdatedNoteTitle({ value }),
            },
            h,
          ),
        ],
      ),
      tagsView(model, inputs, h),
      h.label(
        [h.For('note-body'), h.Class('grid gap-1.5')],
        [
          h.span(
            [h.Class('text-sm font-medium text-base-content/70')],
            ['متن (ساده یا مارک‌داون)'],
          ),
          textAreaControlView(
            {
              id: 'note-body',
              label: 'متن یادداشت',
              value: model.text,
              rows: 14,
              placeholder: 'از همین‌جا شروع کنید…',
              isDisabled: model.isTrashed,
              class: 'min-h-[45dvh] p-4 text-base leading-8',
              onInput: value => Message.UpdatedNoteText({ value }),
            },
            h,
          ),
        ],
      ),
      h.div(
        [h.Class('flex flex-wrap items-center gap-2')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class(
                model.isPinned
                  ? 'btn btn-primary gap-1.5 rounded-full'
                  : 'btn btn-ghost gap-1.5 rounded-full',
              ),
              h.AriaPressed(model.isPinned ? 'true' : 'false'),
              h.Disabled(model.isTrashed),
              h.OnClick(Message.ClickedToggleEditorPinned()),
            ],
            [pinIcon('size-4'), model.isPinned ? 'پین‌شده' : 'پین کردن'],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class('btn btn-ghost gap-1.5 rounded-full'),
              h.Disabled(model.isTrashed),
              h.OnClick(Message.ClickedArchiveNote()),
            ],
            [
              archiveIcon('size-4'),
              model.isArchived ? 'بازگردانی از آرشیو' : 'آرشیو',
            ],
          ),
          model.isOwner
            ? h.button(
                [
                  h.Type('button'),
                  h.Class('btn btn-ghost gap-1.5 rounded-full'),
                  h.Disabled(model.isTrashed),
                  h.AriaLabel(
                    model.visibility === 'shared'
                      ? 'خصوصی کردن این یادداشت'
                      : 'اشتراک این یادداشت با خانه',
                  ),
                  h.OnClick(Message.ClickedToggleNoteVisibility()),
                ],
                [shareActionOf(model.visibility).label],
              )
            : h.empty,
          h.button(
            [
              h.Type('button'),
              h.Class('btn btn-ghost me-auto gap-1.5 rounded-full text-error'),
              h.Disabled(model.isTrashed),
              h.OnClick(Message.ClickedTrashEditedNote()),
            ],
            [trashIcon('size-4'), 'انتقال به سطل زباله'],
          ),
        ],
      ),
    ],
  )

export const noteEditorView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class('min-h-dvh overflow-x-clip bg-base-200 text-base-content'),
      h.Dir('rtl'),
      h.Lang('fa'),
    ],
    [
      h.div(
        [h.Class('page-wrap grid w-full max-w-3xl grid-cols-1 gap-4')],
        [
          h.header(
            [h.Class('flex flex-wrap items-center justify-between gap-3')],
            [
              h.a(
                [h.Href(notesRouter()), h.Class('btn btn-ghost gap-1.5')],
                [h.span([h.AriaHidden(true)], ['→']), 'یادداشت‌ها'],
              ),
              statusView(model, inputs, h),
            ],
          ),
          h.h1([h.Class('sr-only')], ['یادداشت']),
          model.loadState === 'missing' ? missingView(model, h) : h.empty,
          model.loadState === 'loading'
            ? h.p(
                [
                  h.Role('status'),
                  h.Class(
                    'm-0 flex items-center gap-2 text-sm text-base-content/70',
                  ),
                ],
                [
                  h.span([h.Class('spinner spinner-sm')]),
                  'در حال باز کردن یادداشت…',
                ],
              )
            : h.empty,
          model.loadState === 'ready'
            ? h.div(
                [h.Class('grid gap-3')],
                [
                  trashedAlertView(model, h),
                  syncErrorView(model, h),
                  formErrorView(model.maybeActionError, h),
                  editorFormView(model, inputs, h),
                ],
              )
            : h.empty,
        ],
      ),
    ],
  )
