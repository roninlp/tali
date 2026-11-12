import { Option } from 'effect'
import type { Attribute, Html, HtmlBuilder } from 'foldkit/html'

/**
 * The repeated feedback primitives, so every screen draws the same empty
 * state, inline error, and sync badge.
 *
 * The dashed empty state, the `role="alert"` error paragraph, and the
 * pending/error pair are markup the screens had copied by hand; their copy and
 * state stay at the call site.
 */

export type PendingBadgeState = 'pending' | 'error'

export type EmptyStateOptions<Message> = Readonly<{
  /** Extra attributes, such as `h.Role('status')` for a loading or missing state. */
  attributes?: ReadonlyArray<Attribute<Message>>
}>

const EMPTY_STATE_CLASS =
  'm-0 rounded-2xl border border-dashed border-base-300 px-6 py-10 text-center text-sm leading-7 text-base-content/70'

const INLINE_ALERT_CLASS = 'notice notice-error m-0 text-sm leading-7'

const PENDING_BADGE_CLASS = 'badge badge-warning badge-sm'

const ERROR_BADGE_CLASS = 'badge badge-error badge-sm'

export const emptyStateView = <Message>(
  text: string,
  h: HtmlBuilder<Message>,
  options: EmptyStateOptions<Message> = {},
): Html =>
  h.p([h.Class(EMPTY_STATE_CLASS), ...(options.attributes ?? [])], [text])

/** A `role="alert"` paragraph for a message the screen already holds. */
export const inlineAlertView = <Message>(
  maybeMessage: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(maybeMessage, {
    onNone: () => h.empty,
    onSome: message =>
      h.p([h.Role('alert'), h.Class(INLINE_ALERT_CLASS)], [message]),
  })

/**
 * The queued-write badge pair. The pending badge carries the aria label the
 * habits screen already used; the error badge's text names its own state.
 */
export const pendingBadgeView = <Message>(
  state: PendingBadgeState,
  h: HtmlBuilder<Message>,
): Html =>
  state === 'pending'
    ? h.span(
        [h.Class(PENDING_BADGE_CLASS), h.AriaLabel('در انتظار همگام‌سازی')],
        ['در انتظار ارسال'],
      )
    : h.span([h.Class(ERROR_BADGE_CLASS)], ['خطا در همگام‌سازی'])
