import { Menu } from '@foldkit/ui'
import { type Html, type HtmlBuilder, childAttributes } from 'foldkit/html'

import { classNames } from './class-names'
import { logoutIcon, settingsIcon, userIcon } from './icons'

/**
 * The header account menu, ported from the old `<details>` dropdown and
 * rebuilt on the Foldkit UI `Menu` submodel. The menu owns open state,
 * typeahead, and keyboard navigation; `auth.ts` owns the `Menu.Model` and
 * folds `Selected` into its sign-out and navigation messages.
 */

export type AccountItem = 'settings' | 'signout'

export const AccountMenu = Menu.create<AccountItem>()

const ITEMS: ReadonlyArray<AccountItem> = ['settings', 'signout']

export const ACCOUNT_MENU_ID = 'account-menu'

const MENU_ANCHOR = {
  placement: 'bottom-end' as const,
  gap: 4,
  padding: 8,
}

const accountItemLabel = (item: AccountItem, isSigningOut: boolean): string =>
  item === 'settings' ? 'تنظیمات' : isSigningOut ? 'در حال خروج…' : 'خروج'

const accountItemIcon = (item: AccountItem): (className: string) => Html =>
  item === 'settings' ? settingsIcon : logoutIcon

export const accountMenuView = <Message>(
  config: Readonly<{
    menu: Menu.Model
    displayName: string
    isSigningOut: boolean
    toParentMessage: (message: Menu.Message) => Message
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.submodel({
    slotId: config.menu.id,
    model: config.menu,
    view: AccountMenu.view,
    viewInputs: {
      anchor: MENU_ANCHOR,
      items: ITEMS,
      itemToConfig: (item, context) => ({
        className: 'menu-option',
        content: h.span(
          [
            h.Class(
              classNames(
                'flex items-center gap-2',
                context.isDisabled ? 'opacity-50' : undefined,
              ),
            ),
          ],
          [accountItemIcon(item)('size-4'), accountItemLabel(item, config.isSigningOut)],
        ),
      }),
      isItemDisabled: _item => config.isSigningOut,
      itemGroupKey: () => 'account',
      groupToHeading: () => ({
        className: 'menu-heading',
        content: h.span([h.Class('truncate')], [config.displayName]),
      }),
      buttonContent: userIcon('size-5'),
      buttonClassName: 'btn btn-ghost btn-sm btn-circle',
      buttonAttributes: childAttributes([
        h.AriaLabel('حساب کاربری'),
        h.Title('حساب کاربری'),
      ]),
      itemsClassName: 'float-card w-56 p-1 mt-2',
      itemsScrollClassName: 'max-h-72 overflow-auto py-1',
      backdropAttributes: childAttributes([h.Class('float-backdrop')]),
      attributes: childAttributes([h.Class('relative')]),
    },
    toParentMessage: config.toParentMessage,
  })
