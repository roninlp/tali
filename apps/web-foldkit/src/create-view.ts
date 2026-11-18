import type { Html, HtmlBuilder } from 'foldkit/html'

import { Dialog, Popover } from '@foldkit/ui'

import type { Kind } from './create'
import {
  calendarIcon,
  closeIcon,
  habitsIcon,
  notesIcon,
  plusIcon,
  sparklesIcon,
  tasksIcon,
} from './ui/icons'

/**
 * The Today create chrome: the floating `+`, its action menu, and the dialog
 * shell each standalone create form mounts inside.
 */

export const kindLabel: Readonly<Record<Kind, string>> = {
  task: 'کار تازه',
  habit: 'عادت تازه',
  event: 'رویداد تازه',
  occasion: 'مناسبت تازه',
  note: 'یادداشت تازه',
}

export const kindDescription: Readonly<Record<Kind, string>> = {
  task: 'عنوان، موعد، اولویت، پروژه و برچسب‌ها را یک‌جا ثبت کنید.',
  habit: 'عادت را با بسامد، یادآور، نشان و رنگ بسازید.',
  event: 'رویداد امروز را با ساعت شروع و پایان اضافه کنید.',
  occasion: 'تولد یا سالگردی که هر سال در تقویم تکرار می‌شود.',
  note: 'یادداشت را همین‌جا بنویسید تا در دفتر یادداشت‌ها ذخیره شود.',
}

export const kindIcon = (kind: Kind, className: string): Html => {
  if (kind === 'task') {
    return tasksIcon(className)
  }

  if (kind === 'habit') {
    return habitsIcon(className)
  }

  if (kind === 'event') {
    return calendarIcon(className)
  }

  if (kind === 'occasion') {
    return sparklesIcon(className)
  }

  return notesIcon(className)
}

const ACTION_ORDER: ReadonlyArray<Kind> = [
  'task',
  'habit',
  'event',
  'occasion',
  'note',
]

export const menuView = <Message>(
  config: Readonly<{
    render: Popover.RenderInfo
    toSelect: (kind: Kind) => Message
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('pointer-events-auto fixed bottom-20 end-4 z-40 lg:bottom-6')],
    [
      h.button(
        [
          ...config.render.button,
          h.AriaLabel('ساختن چیز تازه'),
          h.Class(
            'grid size-14 cursor-pointer place-items-center rounded-2xl border border-primary/30 bg-primary text-primary-content shadow-lg transition hover:opacity-90 active:scale-95',
          ),
        ],
        [
          h.span(
            [
              h.AriaHidden(true),
              h.Class(
                'transition-transform duration-200 data-[open=true]:rotate-45',
              ),
              h.DataAttribute(
                'open',
                config.render.isVisible ? 'true' : 'false',
              ),
            ],
            [plusIcon('size-6')],
          ),
        ],
      ),
      ...(config.render.isVisible
        ? [h.div([...config.render.backdrop, h.Class('fixed inset-0 z-[45]')])]
        : []),
      config.render.isVisible
        ? h.div(
            [
              ...config.render.panel,
              h.Role('group'),
              h.AriaLabel('ساختن چیز تازه'),
              h.Class('float-card z-[60] grid w-52 gap-1 p-1.5'),
            ],
            [
              ...ACTION_ORDER.map(kind =>
                h.button(
                  [
                    h.Type('button'),
                    h.Class(
                      'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-start text-[0.84rem] text-base-content/80 transition-colors hover:bg-base-content/5 hover:text-base-content',
                    ),
                    h.OnClick(config.toSelect(kind)),
                    h.AriaLabel(kindLabel[kind]),
                    h.DataAttribute('create-action', 'true'),
                  ],
                  [
                    h.span(
                      [
                        h.Class(
                          'grid size-7 flex-none place-items-center rounded-lg bg-primary/10 text-primary',
                        ),
                      ],
                      [kindIcon(kind, 'size-4')],
                    ),
                    h.span([h.Class('truncate')], [kindLabel[kind]]),
                  ],
                ),
              ),
            ],
          )
        : h.empty,
    ],
  )

export const dialogView = <Message>(
  config: Readonly<{
    render: Dialog.RenderInfo
    kind: Kind
    body: Html
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.dialog(
    [
      ...config.render.dialog,
      h.Class(
        'app-modal pointer-events-auto items-end p-0 sm:items-center sm:p-4',
      ),
    ],
    config.render.isVisible
      ? [
          h.div([...config.render.backdrop, h.Class('app-modal-backdrop')]),
          h.div(
            [
              ...config.render.panel,
              h.Class(
                'float-card grid max-h-[calc(100dvh-2rem)] w-full max-w-lg gap-4 overflow-y-auto rounded-b-none rounded-t-3xl p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:rounded-2xl sm:p-5',
              ),
            ],
            [
              h.div(
                [h.Class('flex items-start justify-between gap-3')],
                [
                  h.div(
                    [h.Class('grid min-w-0 gap-1')],
                    [
                      h.h2(
                        [
                          ...config.render.title,
                          h.Class('m-0 text-lg font-bold'),
                        ],
                        [kindLabel[config.kind]],
                      ),
                      h.p(
                        [
                          ...config.render.description,
                          h.Class(
                            'm-0 text-[0.78rem] leading-6 text-base-content/70',
                          ),
                        ],
                        [kindDescription[config.kind]],
                      ),
                    ],
                  ),
                  h.button(
                    [
                      ...config.render.closeButton,
                      h.Type('button'),
                      h.AriaLabel('بستن'),
                      h.Class(
                        'grid size-8 flex-none place-items-center rounded-lg text-base-content/70 transition-colors hover:bg-base-200 hover:text-base-content',
                      ),
                    ],
                    [closeIcon('size-4')],
                  ),
                ],
              ),
              config.body,
            ],
          ),
        ]
      : [],
  )
