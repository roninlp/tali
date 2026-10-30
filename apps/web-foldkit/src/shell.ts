import type { Html, HtmlBuilder } from 'foldkit/html'

/**
 * The signed-in app chrome shared by every household screen.
 *
 * P2.1 carries the frame only: the brand and the header action slot. The
 * section navigation, sync status, quick-note action and account menu arrive
 * with the navigation (P2.2), auth (P2.3) and local-store (P2.4) slices, each
 * plugging into `actions` or extending this module.
 */

export type ShellConfig = Readonly<{
  /** Header actions, rendered at the inline-end of the top bar. */
  actions: Html
  /** The active route's content. */
  content: Html
}>

const brandView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex shrink-0 items-center gap-2 rounded-lg px-1 py-1')],
    [
      h.span(
        [
          h.Class(
            'grid size-8 place-items-center rounded-xl bg-primary text-sm font-black text-primary-content shadow-sm',
          ),
        ],
        ['ت'],
      ),
      h.span(
        [h.Class('hidden text-base font-bold tracking-tight sm:inline')],
        ['تالی'],
      ),
    ],
  )

export const view = <Message>(
  config: ShellConfig,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('grid min-h-dvh grid-rows-[auto_1fr] bg-base-200')],
    [
      h.header(
        [
          h.Class(
            'sticky inset-x-0 top-0 z-40 border-b border-base-300 bg-base-100/90 backdrop-blur-md',
          ),
        ],
        [
          h.div(
            [
              h.Class(
                'mx-auto flex h-14 w-full max-w-7xl items-center gap-2 px-3 sm:h-16 sm:px-6',
              ),
            ],
            [
              brandView(h),
              h.div(
                [h.Class('ms-auto flex items-center gap-1')],
                [config.actions],
              ),
            ],
          ),
        ],
      ),
      h.main([h.Class('py-8')], [config.content]),
    ],
  )
