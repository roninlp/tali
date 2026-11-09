import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { buildVariantInsensitivePattern, localizeDigits } from '@tali/domain'

import type { NoteSearchSegment } from '../lib/note-search'
import { excerptAroundMatch, markMatches } from '../lib/note-search'
import type { NoteRow } from '../mirror'
import { notePath, notesTrashRouter } from '../route'
import { buttonView } from '../ui/button'
import { formErrorView, inputControlView } from '../ui/field'
import {
  archiveIcon,
  pinIcon,
  plusIcon,
  searchIcon,
  trashIcon,
} from '../ui/icons'
import { Message } from './notes'
import type { Model, SearchHit, ViewInputs } from './notes'
import { noteSections, pendingNoteIds } from './notes-model'

/**
 * `/notes` index view, ported from
 * `apps/web/src/components/notes/notes-screen.tsx`.
 *
 * Pinned notes lead, then all active notes, then the archive. Search replaces
 * the list while a query is active: the server's FTS5 index answers, and the
 * local mirror answers when the network is gone.
 */

const tagNameOf = (inputs: ViewInputs, tagId: string): string =>
  Option.match(
    Array.findFirst(inputs.mirror.tags, tag => tag.id === tagId),
    {
      onNone: () => '',
      onSome: tag => tag.name,
    },
  )

const markedView = (
  segments: ReadonlyArray<NoteSearchSegment>,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [],
    Array.map(segments, segment =>
      segment.match
        ? h.mark(
            [h.Class('rounded-sm bg-warning/30 px-0.5 text-base-content')],
            [segment.text],
          )
        : h.span([], [segment.text]),
    ),
  )

const noteLookup = (
  inputs: ViewInputs,
  noteId: string,
): Option.Option<NoteRow> =>
  Array.findFirst(inputs.mirror.notes, note => note.id === noteId)

const titleSegments = (
  model: Model,
  inputs: ViewInputs,
  hit: SearchHit,
): ReadonlyArray<NoteSearchSegment> => {
  const pattern = buildVariantInsensitivePattern(model.query.trim())

  if (pattern === undefined) {
    return [{ text: hit.title, match: false }]
  }

  return markMatches(
    Option.match(noteLookup(inputs, hit.id), {
      onNone: () => hit.title,
      onSome: note => note.title,
    }),
    pattern,
  )
}

const snippetSegments = (
  model: Model,
  inputs: ViewInputs,
  hit: SearchHit,
): ReadonlyArray<NoteSearchSegment> => {
  const pattern = buildVariantInsensitivePattern(model.query.trim())

  if (pattern === undefined) {
    return hit.segments
  }

  return Option.match(noteLookup(inputs, hit.id), {
    onNone: () => hit.segments,
    onSome: note => {
      const source = note.text !== '' ? note.text : note.title
      const excerpt = excerptAroundMatch(source, pattern)

      return Array.isReadonlyArrayNonEmpty(excerpt) ? excerpt : hit.segments
    },
  })
}

const searchResultView = (
  model: Model,
  inputs: ViewInputs,
  hit: SearchHit,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('li')(
    hit.id,
    [h.Class('grid min-w-0 gap-1.5 py-3')],
    [
      h.a(
        [
          h.Href(notePath(hit.id)),
          h.Class(
            'text-start text-[0.95rem] leading-7 font-semibold break-words text-base-content underline-offset-4 transition-colors hover:text-primary hover:underline',
          ),
        ],
        [markedView(titleSegments(model, inputs, hit), h)],
      ),
      Array.isReadonlyArrayNonEmpty(hit.segments)
        ? h.p(
            [h.Class('m-0 text-sm leading-7 break-words text-base-content/55')],
            [markedView(snippetSegments(model, inputs, hit), h)],
          )
        : h.empty,
    ],
  )

const searchResultsView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.Class('panel grid grid-cols-1 gap-3 p-4 sm:p-5'),
      h.AriaLabel('نتیجه‌های جست‌وجو'),
    ],
    [
      h.h2([h.Class('m-0 text-[0.95rem] font-semibold')], ['نتیجه‌ها']),
      Array.match(model.searchHits, {
        onEmpty: () =>
          h.p(
            [h.Class('m-0 text-sm leading-7 text-base-content/55')],
            ['چیزی پیدا نشد.'],
          ),
        onNonEmpty: hits =>
          h.ul(
            [h.Class('m-0 list-none divide-y divide-base-300 p-0')],
            Array.map(hits, hit => searchResultView(model, inputs, hit, h)),
          ),
      }),
    ],
  )

const searchSectionView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('panel grid grid-cols-1 gap-2 p-4 sm:p-5'), h.AriaLabel('جست‌وجو')],
    [
      h.label(
        [
          h.For('note-search'),
          h.Class('text-sm font-medium text-base-content/70'),
        ],
        ['جست‌وجو در یادداشت‌ها (Ctrl+K)'],
      ),
      h.div(
        [h.Class('flex items-center gap-2')],
        [
          h.span(
            [
              h.Class(
                'flex min-h-11 flex-1 items-center gap-2 rounded-xl border border-base-300 bg-base-100 px-3 focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/10',
              ),
            ],
            [
              searchIcon('size-4 shrink-0 text-base-content/40'),
              inputControlView(
                {
                  id: 'note-search',
                  label: 'جست‌وجو در یادداشت‌ها',
                  type: 'search',
                  value: model.query,
                  placeholder: 'مثلاً: دارو',
                  autoComplete: 'off',
                  class:
                    'min-w-0 flex-1 border-0 bg-transparent leading-10 outline-none',
                  onInput: value => Message.UpdatedSearchQuery({ value }),
                  attributes: [
                    h.OnKeyDownPreventDefault(key =>
                      key === 'Escape'
                        ? Option.some(Message.ClickedClearSearch())
                        : Option.none(),
                    ),
                  ],
                },
                h,
              ),
            ],
          ),
          model.query.trim() !== ''
            ? buttonView(
                {
                  type: 'button',
                  variant: 'ghost',
                  size: 'sm',
                  onClick: Message.ClickedClearSearch(),
                  children: ['پاک کردن'],
                },
                h,
              )
            : h.empty,
        ],
      ),
      model.isSearching
        ? h.p(
            [
              h.Role('status'),
              h.Class(
                'm-0 flex items-center gap-2 text-sm text-base-content/55',
              ),
            ],
            [h.span([h.Class('spinner spinner-xs')]), 'در حال جست‌وجو…'],
          )
        : h.empty,
      model.isOfflineSearch
        ? h.p(
            [h.Role('status'), h.Class('soft-note m-0')],
            [
              'جست‌وجو روی همین دستگاه انجام شد؛ نتیجه‌های سرور بعد از همگام‌سازی کامل می‌شود.',
            ],
          )
        : h.empty,
    ],
  )

const noteActionsView = (note: NoteRow, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-wrap items-center gap-1')],
    [
      h.button(
        [
          h.Type('button'),
          h.Class(
            note.isPinned
              ? 'btn btn-primary btn-xs min-h-10 gap-1 rounded-full font-normal'
              : 'btn btn-ghost btn-xs min-h-10 gap-1 rounded-full font-normal',
          ),
          h.AriaPressed(note.isPinned ? 'true' : 'false'),
          h.AriaLabel(note.isPinned ? 'برداشتن پین' : 'پین کردن'),
          h.OnClick(
            Message.ClickedTogglePinned({
              noteId: note.id,
              isPinned: !note.isPinned,
            }),
          ),
        ],
        [pinIcon('size-3.5'), note.isPinned ? 'پین‌شده' : 'پین'],
      ),
      h.button(
        [
          h.Type('button'),
          h.Class(
            'btn btn-ghost btn-xs min-h-10 gap-1 rounded-full font-normal',
          ),
          h.AriaLabel(note.isArchived ? 'بازگردانی از آرشیو' : 'آرشیو کردن'),
          h.OnClick(
            Message.ClickedToggleArchived({
              noteId: note.id,
              isArchived: !note.isArchived,
            }),
          ),
        ],
        [archiveIcon('size-3.5'), note.isArchived ? 'بازگردانی' : 'آرشیو'],
      ),
      h.button(
        [
          h.Type('button'),
          h.Class(
            'btn btn-ghost btn-xs min-h-10 gap-1 rounded-full font-normal text-error',
          ),
          h.AriaLabel('انتقال به سطل زباله'),
          h.OnClick(Message.ClickedTrashNote({ noteId: note.id })),
        ],
        [trashIcon('size-3.5'), 'حذف'],
      ),
    ],
  )

const noteRowView = (
  note: NoteRow,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const isPending = Array.contains(pendingNoteIds(inputs.pendingKeys), note.id)

  return h.keyed('li')(
    note.id,
    [
      h.Class(
        '-mx-2 grid min-w-0 gap-1.5 rounded-xl px-2 py-3 transition-colors hover:bg-base-content/[0.03] data-[pending=true]:opacity-85',
      ),
      h.DataAttribute('pending', isPending ? 'true' : 'false'),
    ],
    [
      h.div(
        [h.Class('flex flex-wrap items-baseline gap-2')],
        [
          h.a(
            [
              h.Href(notePath(note.id)),
              h.Class(
                'text-start text-[0.95rem] leading-7 font-semibold break-words text-base-content underline-offset-4 transition-colors hover:text-primary hover:underline',
              ),
            ],
            [note.title],
          ),
          Array.isReadonlyArrayNonEmpty(note.tagIds)
            ? h.span(
                [h.Class('flex flex-wrap items-center gap-1')],
                Array.map(note.tagIds, tagId =>
                  h.span(
                    [h.Class('badge badge-ghost badge-sm')],
                    [tagNameOf(inputs, tagId)],
                  ),
                ),
              )
            : h.empty,
          note.isPinned
            ? h.span(
                [h.Class('badge badge-primary badge-sm gap-1')],
                [pinIcon('size-3'), 'پین'],
              )
            : h.empty,
          isPending
            ? h.span(
                [h.Class('badge badge-warning badge-sm')],
                ['در انتظار ارسال'],
              )
            : h.empty,
          Option.isSome(note.syncErrorCode)
            ? h.span(
                [h.Class('badge badge-error badge-sm')],
                ['خطا در همگام‌سازی'],
              )
            : h.empty,
        ],
      ),
      note.excerpt !== ''
        ? h.p(
            [h.Class('m-0 text-sm leading-7 break-words text-base-content/55')],
            [note.excerpt],
          )
        : h.empty,
      noteActionsView(note, h),
    ],
  )
}

const noteSectionView = (
  label: string,
  title: string,
  notes: ReadonlyArray<NoteRow>,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
  emptyCopy: string,
): Html =>
  h.section(
    [h.Class('panel grid grid-cols-1 gap-3 p-4 sm:p-5'), h.AriaLabel(label)],
    [
      h.h2([h.Class('m-0 text-[0.95rem] font-semibold')], [title]),
      Array.match(notes, {
        onEmpty: () =>
          h.p(
            [h.Class('m-0 text-sm leading-7 text-base-content/55')],
            [emptyCopy],
          ),
        onNonEmpty: rows =>
          h.ul(
            [h.Class('m-0 list-none divide-y divide-base-300 p-0')],
            Array.map(rows, note => noteRowView(note, inputs, h)),
          ),
      }),
    ],
  )

const archiveSectionView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const sections = noteSections(inputs.mirror.notes, model.selectedTagIds)
  const count = localizeDigits(sections.archived.length, inputs.display.digits)

  return h.section(
    [h.Class('panel grid grid-cols-1 gap-3 p-4 sm:p-5'), h.AriaLabel('آرشیو')],
    [
      h.button(
        [
          h.Type('button'),
          h.Class(
            'btn btn-ghost btn-sm w-fit gap-1.5 rounded-full font-normal',
          ),
          h.AriaExpanded(model.showArchived),
          h.OnClick(Message.ToggledArchive()),
        ],
        [archiveIcon('size-4'), `آرشیو (${count})`],
      ),
      model.showArchived
        ? Array.match(sections.archived, {
            onEmpty: () =>
              h.p(
                [h.Class('m-0 text-sm leading-7 text-base-content/55')],
                ['آرشیو خالی است.'],
              ),
            onNonEmpty: rows =>
              h.ul(
                [h.Class('m-0 list-none divide-y divide-base-300 p-0')],
                Array.map(rows, note => noteRowView(note, inputs, h)),
              ),
          })
        : h.empty,
    ],
  )
}

const tagFilterView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(inputs.mirror.tags, {
    onEmpty: () => h.empty,
    onNonEmpty: tags =>
      h.section(
        [
          h.Class('flex flex-wrap items-center gap-1.5'),
          h.AriaLabel('فیلتر برچسب'),
        ],
        Array.map(tags, tag => {
          const isSelected = Array.contains(model.selectedTagIds, tag.id)

          return h.button(
            [
              h.Type('button'),
              h.Class(
                isSelected
                  ? 'badge badge-primary badge-lg min-h-10 cursor-pointer'
                  : 'badge badge-ghost badge-lg min-h-10 cursor-pointer',
              ),
              h.AriaPressed(isSelected ? 'true' : 'false'),
              h.OnClick(Message.ToggledTagFilter({ tagId: tag.id })),
            ],
            [tag.name],
          )
        }),
      ),
  })

export const notesIndexView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const query = model.query.trim()
  const sections = noteSections(inputs.mirror.notes, model.selectedTagIds)
  const sectionsView =
    query !== ''
      ? h.empty
      : Array.match(inputs.mirror.notes, {
          onEmpty: () =>
            h.section(
              [h.Class('panel grid grid-cols-1 gap-1.5 p-4 sm:p-5')],
              [
                h.p(
                  [h.Class('m-0 text-sm leading-8 font-semibold')],
                  ['هنوز یادداشتی ندارید.'],
                ),
                h.p(
                  [h.Class('m-0 text-sm leading-7 text-base-content/55')],
                  [
                    'از هر صفحه با دکمه‌ی «یادداشت تازه» یا Alt+N شروع کنید؛ همان لحظه باز می‌شود.',
                  ],
                ),
              ],
            ),
          onNonEmpty: () =>
            h.div(
              [h.Class('grid gap-4')],
              [
                Array.isReadonlyArrayNonEmpty(sections.pinned)
                  ? noteSectionView(
                      'یادداشت‌های پین‌شده',
                      'پین‌شده',
                      sections.pinned,
                      inputs,
                      h,
                      'یادداشت پین‌شده‌ای نیست.',
                    )
                  : h.empty,
                noteSectionView(
                  'همه‌ی یادداشت‌ها',
                  'یادداشت‌ها',
                  sections.active,
                  inputs,
                  h,
                  'یادداشت دیگری نیست.',
                ),
                archiveSectionView(model, inputs, h),
              ],
            ),
        })

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
                    ['یادداشت‌ها'],
                  ),
                  h.p(
                    [h.Class('m-0 text-sm leading-7 text-base-content/55')],
                    [
                      'جست‌وجو، پین، آرشیو و برچسب — همه روی همین دستگاه اول ذخیره می‌شوند.',
                    ],
                  ),
                ],
              ),
              h.div(
                [h.Class('flex flex-wrap items-center gap-2')],
                [
                  buttonView(
                    {
                      type: 'button',
                      onClick: Message.SubmittedCreateNote(),
                      isDisabled: !inputs.isStoreReady,
                      isLoading: model.isCreatingNote,
                      class: 'gap-1.5',
                      children: [plusIcon('size-4'), 'یادداشت تازه'],
                    },
                    h,
                  ),
                  h.a(
                    [
                      h.Href(notesTrashRouter()),
                      h.Class('btn btn-ghost gap-1.5'),
                    ],
                    [trashIcon('size-4'), 'سطل زباله'],
                  ),
                ],
              ),
            ],
          ),
          inputs.isOnline
            ? h.empty
            : h.p(
                [h.Role('status'), h.Class('soft-note m-0')],
                [
                  'آفلاین هستید؛ همه‌ی تغییرها روی همین دستگاه ذخیره می‌شوند و بعد همگام می‌شوند.',
                ],
              ),
          formErrorView(model.maybeIndexError, h),
          searchSectionView(model, h),
          query !== '' ? searchResultsView(model, inputs, h) : h.empty,
          tagFilterView(model, inputs, h),
          sectionsView,
          h.p(
            [h.Role('status'), h.AriaLive('polite'), h.Class('sr-only')],
            [model.announcement],
          ),
        ],
      ),
    ],
  )
}
