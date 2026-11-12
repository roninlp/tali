import type { Html, HtmlBuilder } from 'foldkit/html'

import { type Digits, localizeDigits } from '@tali/domain'

/**
 * The shared page chrome: the title block, the offline warning, and the
 * outbox count every local-first screen repeats.
 *
 * The title block is the plain `h1` plus subtitle pair; a screen with a
 * trailing action cluster passes it as `actions`, and one with extra status
 * lines passes them as `details`. Header layouts the helper does not cover
 * (the calendar's view tabs, the habits source hint) stay owned by their
 * screen.
 */

const HEADER_CLASS = 'grid gap-1.5'

const HEADER_WITH_ACTIONS_CLASS =
  'flex flex-wrap items-center justify-between gap-3'

const OFFLINE_NOTICE_CLASS = 'notice notice-warning m-0'

const PENDING_COUNT_CLASS = 'm-0 text-[0.78rem] leading-6 text-base-content/70'

export type PageHeaderConfig = Readonly<{
  title: string
  subtitle: string
  /** Lines rendered under the subtitle, inside the title block. */
  details?: ReadonlyArray<Html>
  /** Trailing cluster rendered beside the title block. */
  actions?: Html
}>

export const pageHeaderView = <Message>(
  config: PageHeaderConfig,
  h: HtmlBuilder<Message>,
): Html => {
  const titleBlock = [
    h.h1(
      [h.Class('m-0 text-2xl font-bold tracking-tight sm:text-3xl')],
      [config.title],
    ),
    h.p(
      [h.Class('m-0 text-sm leading-7 text-base-content/70')],
      [config.subtitle],
    ),
    ...(config.details ?? []),
  ]

  return config.actions === undefined
    ? h.header([h.Class(HEADER_CLASS)], titleBlock)
    : h.header(
        [h.Class(HEADER_WITH_ACTIONS_CLASS)],
        [h.div([h.Class(HEADER_CLASS)], titleBlock), config.actions],
      )
}

/** One screen's own offline copy, shown only while the browser is offline. */
export const offlineNoticeView = <Message>(
  isOnline: boolean,
  message: string,
  h: HtmlBuilder<Message>,
): Html =>
  isOnline
    ? h.empty
    : h.p([h.Role('status'), h.Class(OFFLINE_NOTICE_CLASS)], [message])

export const pendingCountView = <Message>(
  pending: number,
  digits: Digits,
  h: HtmlBuilder<Message>,
): Html =>
  pending > 0
    ? h.p(
        [h.Role('status'), h.AriaLive('polite'), h.Class(PENDING_COUNT_CLASS)],
        [`${localizeDigits(pending, digits)} تغییر در صف همگام‌سازی است.`],
      )
    : h.empty
