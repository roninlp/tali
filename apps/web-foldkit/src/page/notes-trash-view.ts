import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { notesRouter } from '../route'
import { buttonView } from '../ui/button'
import { formErrorView } from '../ui/field'
import { Message } from './notes'
import type { Model, ViewInputs } from './notes'
import { sortTrashedNoteRows } from './notes-model'

/**
 * `/notes/trash` view, ported from `apps/web/src/routes/notes/trash.tsx`.
 *
 * Deleted notes are soft-deleted mirror tombstones and stay restorable for the
 * shared 30-day window. The screen renders them from the live mirror snapshot,
 * so a restore removes the row without a refresh.
 */

export const notesTrashView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const rows = sortTrashedNoteRows(inputs.mirror.trashedNotes)

  return h.div(
    [h.Class('notes-root'), h.Dir('rtl'), h.Lang('fa')],
    [
      h.div(
        [h.Class('notes-screen page-wrap')],
        [
          h.header(
            [h.Class('notes-header')],
            [
              h.div(
                [h.Class('notes-heading')],
                [
                  h.h1([h.Class('notes-h1')], ['سطل زباله']),
                  h.p(
                    [h.Class('notes-subtitle')],
                    [
                      'یادداشت‌های حذف‌شده تا ۳۰ روز اینجا می‌مانند و بعد از آن پاک می‌شوند.',
                    ],
                  ),
                ],
              ),
              h.a(
                [h.Href(notesRouter()), h.Class('btn btn-ghost')],
                ['بازگشت به یادداشت‌ها'],
              ),
            ],
          ),
          formErrorView(model.maybeTrashError, h),
          Array.match(rows, {
            onEmpty: () =>
              h.section(
                [h.Class('panel notes-panel notes-trash-empty')],
                [
                  h.p(
                    [h.Class('m-0 text-base-content/55')],
                    ['سطل زباله خالی است.'],
                  ),
                ],
              ),
            onNonEmpty: notes =>
              h.section(
                [h.Class('panel notes-panel')],
                [
                  h.ul(
                    [h.Class('notes-list')],
                    Array.map(notes, note => {
                      const isBusy = Option.contains(
                        model.maybeRestoringId,
                        note.id,
                      )

                      return h.keyed('li')(
                        note.id,
                        [h.Class('notes-row notes-trash-row')],
                        [
                          h.strong(
                            [h.Class('notes-trash-title')],
                            [note.title],
                          ),
                          note.excerpt !== ''
                            ? h.span([h.Class('notes-excerpt')], [note.excerpt])
                            : h.empty,
                          h.div(
                            [],
                            [
                              buttonView(
                                {
                                  type: 'button',
                                  size: 'sm',
                                  isDisabled: Option.isSome(
                                    model.maybeRestoringId,
                                  ),
                                  isLoading: isBusy,
                                  onClick: Message.ClickedRestoreTrashedNote({
                                    noteId: note.id,
                                  }),
                                  children: [
                                    isBusy ? 'در حال بازگردانی…' : 'بازگردانی',
                                  ],
                                },
                                h,
                              ),
                            ],
                          ),
                        ],
                      )
                    }),
                  ),
                ],
              ),
          }),
          h.p(
            [h.Role('status'), h.AriaLive('polite'), h.Class('notes-sr')],
            [model.announcement],
          ),
        ],
      ),
    ],
  )
}
