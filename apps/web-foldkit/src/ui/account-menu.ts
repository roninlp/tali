import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { formErrorView } from './field'
import { logoutIcon, settingsIcon, userIcon } from './icons'

/**
 * The header account menu, ported from `apps/web/src/components/app-header.tsx`.
 *
 * The disclosure is browser-owned (`<details>`), so no Model state tracks
 * whether it is open. Sign-out progress and failure come from the auth Model.
 */

export type AccountMenuConfig<Message> = Readonly<{
  displayName: string
  isSigningOut: boolean
  maybeError: Option.Option<string>
  onSignOut: Message
  settingsHref: string
}>

export const accountMenuView = <Message>(
  config: AccountMenuConfig<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  h.details(
    [h.Class('dropdown dropdown-end')],
    [
      h.summary(
        [
          h.Class('btn btn-ghost btn-circle btn-sm'),
          h.AriaLabel('حساب کاربری'),
          h.Title('حساب کاربری'),
        ],
        [userIcon('size-5')],
      ),
      h.ul(
        [
          h.Class(
            'menu dropdown-content z-50 mt-2 w-56 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg',
          ),
        ],
        [
          h.li(
            [h.Class('menu-title')],
            [h.span([h.Class('truncate')], [config.displayName])],
          ),
          h.li(
            [],
            [
              h.a(
                [h.Href(config.settingsHref)],
                [settingsIcon('size-4'), 'تنظیمات'],
              ),
            ],
          ),
          h.li(
            [],
            [
              h.button(
                [
                  h.Type('button'),
                  h.Disabled(config.isSigningOut),
                  h.OnClick(config.onSignOut),
                ],
                [
                  logoutIcon('size-4'),
                  config.isSigningOut ? 'در حال خروج…' : 'خروج',
                ],
              ),
            ],
          ),
          Option.match(config.maybeError, {
            onNone: () => h.empty,
            onSome: message =>
              h.li([h.Class('p-1')], [formErrorView(Option.some(message), h)]),
          }),
        ],
      ),
    ],
  )
