import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { syncFailureMessage } from '../lib/sync-copy'
import { shareActionOf } from '../lib/visibility-writes'
import { notesRouter, notesTrashRouter } from '../route'
import { buttonView } from '../ui/button'
import { formErrorView } from '../ui/field'
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
          ? 'badge badge-error badge-sm notes-status'
          : 'badge badge-ghost badge-sm notes-status',
      ),
    ],
    [
      model.saveState === 'saving'
        ? h.span([h.Class('loading loading-spinner loading-xs')])
        : h.span([h.Class('notes-status-dot')]),
      model.loadState === 'ready' ? statusText(model, inputs) : '',
    ],
  )
}

const missingView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('panel notes-panel notes-missing')],
    [
      h.p(
        [h.Class('m-0 leading-8')],
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
        [h.Class('notes-editor-tags'), h.AriaLabel('برچسب‌ها')],
        Array.map(tags, tag => {
          const isSelected = Array.contains(model.tagIds, tag.id)

          return h.button(
            [
              h.Type('button'),
              h.Class(
                isSelected
                  ? 'badge badge-primary cursor-pointer'
                  : 'badge badge-ghost cursor-pointer',
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
        [h.Class('alert alert-warning items-start notes-alert')],
        [
          h.div(
            [h.Class('grid gap-2')],
            [
              h.p(
                [h.Class('m-0 font-medium')],
                ['این یادداشت در سطل زباله است.'],
              ),
              h.div(
                [h.Class('notes-alert-actions')],
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
        [h.Role('alert'), h.Class('alert alert-error items-start notes-alert')],
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
    [h.Class('panel notes-editor-panel')],
    [
      h.label(
        [h.For('note-title'), h.Class('notes-field')],
        [
          h.span([h.Class('notes-field-label')], ['عنوان']),
          h.input([
            h.Id('note-title'),
            h.Type('text'),
            h.Class('input input-lg w-full font-bold'),
            h.AriaLabel('عنوان یادداشت'),
            h.Placeholder('بی‌عنوان'),
            h.Value(model.title),
            h.Disabled(model.isTrashed),
            h.OnInput(value => Message.UpdatedNoteTitle({ value })),
          ]),
        ],
      ),
      tagsView(model, inputs, h),
      h.label(
        [h.For('note-body'), h.Class('notes-field')],
        [
          h.span([h.Class('notes-field-label')], ['متن (ساده یا مارک‌داون)']),
          h.textarea([
            h.Id('note-body'),
            h.AriaLabel('متن یادداشت'),
            h.Class('textarea textarea-bordered notes-editor-body'),
            h.Placeholder('از همین‌جا شروع کنید…'),
            h.Value(model.text),
            h.Rows(14),
            h.Readonly(model.isTrashed),
            h.Disabled(model.isTrashed),
            h.OnInput(value => Message.UpdatedNoteText({ value })),
          ]),
        ],
      ),
      h.div(
        [h.Class('notes-editor-actions')],
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
    [h.Class('notes-root'), h.Dir('rtl'), h.Lang('fa')],
    [
      h.div(
        [h.Class('notes-screen page-wrap')],
        [
          h.header(
            [h.Class('notes-editor-head')],
            [
              h.a(
                [h.Href(notesRouter()), h.Class('btn btn-ghost notes-back')],
                [h.span([h.AriaHidden(true)], ['→']), 'یادداشت‌ها'],
              ),
              statusView(model, inputs, h),
            ],
          ),
          h.h1([h.Class('notes-sr')], ['یادداشت']),
          model.loadState === 'missing' ? missingView(model, h) : h.empty,
          model.loadState === 'loading'
            ? h.p(
                [h.Role('status'), h.Class('notes-loading')],
                [
                  h.span([h.Class('loading loading-spinner loading-sm')]),
                  'در حال باز کردن یادداشت…',
                ],
              )
            : h.empty,
          model.loadState === 'ready'
            ? h.div(
                [h.Class('notes-editor')],
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
