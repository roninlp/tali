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
              h.div(
                [h.Class('grid gap-1')],
                [
                  h.h1(
                    [
                      h.Class(
                        'm-0 text-2xl font-bold tracking-tight sm:text-3xl',
                      ),
                    ],
                    ['سطل زباله'],
                  ),
                  h.p(
                    [h.Class('m-0 text-sm leading-7 text-base-content/70')],
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
                [
                  h.Class(
                    'panel grid grid-cols-1 justify-items-center gap-2 px-6 py-12',
                  ),
                ],
                [
                  h.p(
                    [h.Class('m-0 text-sm leading-7 text-base-content/70')],
                    ['سطل زباله خالی است.'],
                  ),
                ],
              ),
            onNonEmpty: notes =>
              h.section(
                [h.Class('panel p-4 sm:p-5')],
                [
                  h.ul(
                    [h.Class('m-0 list-none divide-y divide-base-300 p-0')],
                    Array.map(notes, note => {
                      const isBusy = Option.contains(
                        model.maybeRestoringId,
                        note.id,
                      )

                      return h.keyed('li')(
                        note.id,
                        [h.Class('grid min-w-0 gap-1.5 py-3')],
                        [
                          h.strong(
                            [
                              h.Class(
                                'text-[0.95rem] leading-7 font-semibold break-words',
                              ),
                            ],
                            [note.title],
                          ),
                          note.excerpt !== ''
                            ? h.span(
                                [
                                  h.Class(
                                    'text-sm leading-7 break-words text-base-content/70',
                                  ),
                                ],
                                [note.excerpt],
                              )
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
            [h.Role('status'), h.AriaLive('polite'), h.Class('sr-only')],
            [model.announcement],
          ),
        ],
      ),
    ],
  )
}
