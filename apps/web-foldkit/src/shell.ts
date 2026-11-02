import { Array, Option } from 'effect'
import { inertHtml as ih } from 'foldkit/html'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Nav } from '@foldkit/ui'

import {
  AppRoute,
  calendarRouter,
  habitsRouter,
  listsRouter,
  notesRouter,
  remindersRouter,
  settingsRouter,
  tasksRouter,
  todayRouter,
} from './route'
import { classNames } from './ui/class-names'
import {
  calendarIcon,
  habitsIcon,
  listsIcon,
  notesIcon,
  remindersIcon,
  settingsIcon,
  tasksIcon,
  todayIcon,
} from './ui/icons'

/**
 * The app chrome shared by every signed-in screen.
 *
 * Both navigation landmarks are built on the Foldkit UI `Nav` helper, which
 * marks the current destination with `aria-current="page"`; the markup and
 * classes stay local. Phones get a fixed bottom tab bar with the four primary
 * destinations plus the "more" popover rendered by the application shell.
 */

export type AppSection =
  | 'Today'
  | 'Calendar'
  | 'Tasks'
  | 'Habits'
  | 'Lists'
  | 'Notes'
  | 'Reminders'
  | 'Settings'

type NavItem = Readonly<{
  section: AppSection
  href: string
  label: string
  icon: (className: string) => Html
}>

const NAV_ITEMS: Readonly<Record<AppSection, NavItem>> = {
  Today: {
    section: 'Today',
    href: todayRouter(),
    label: 'امروز',
    icon: todayIcon,
  },
  Calendar: {
    section: 'Calendar',
    href: calendarRouter(),
    label: 'تقویم',
    icon: calendarIcon,
  },
  Tasks: {
    section: 'Tasks',
    href: tasksRouter(),
    label: 'کارها',
    icon: tasksIcon,
  },
  Habits: {
    section: 'Habits',
    href: habitsRouter(),
    label: 'عادت‌ها',
    icon: habitsIcon,
  },
  Lists: {
    section: 'Lists',
    href: listsRouter(),
    label: 'فهرست‌ها',
    icon: listsIcon,
  },
  Notes: {
    section: 'Notes',
    href: notesRouter(),
    label: 'یادداشت‌ها',
    icon: notesIcon,
  },
  Reminders: {
    section: 'Reminders',
    href: remindersRouter(),
    label: 'یادآورها',
    icon: remindersIcon,
  },
  Settings: {
    section: 'Settings',
    href: settingsRouter(),
    label: 'تنظیمات',
    icon: settingsIcon,
  },
}

const DESKTOP_SECTIONS: ReadonlyArray<AppSection> = [
  'Today',
  'Calendar',
  'Tasks',
  'Habits',
  'Lists',
  'Notes',
  'Reminders',
  'Settings',
]

const MOBILE_PRIMARY_SECTIONS: ReadonlyArray<AppSection> = [
  'Today',
  'Tasks',
  'Calendar',
  'Notes',
]

export const sectionForRoute = (route: AppRoute): Option.Option<AppSection> =>
  AppRoute.match<Option.Option<AppSection>>(route, {
    Home: () => Option.none(),
    Login: () => Option.none(),
    Register: () => Option.none(),
    Today: () => Option.some('Today'),
    Tasks: () => Option.some('Tasks'),
    Lists: () => Option.some('Lists'),
    List: () => Option.some('Lists'),
    Notes: () => Option.some('Notes'),
    Note: () => Option.some('Notes'),
    NotesTrash: () => Option.some('Notes'),
    Habits: () => Option.some('Habits'),
    Calendar: () => Option.some('Calendar'),
    Reminders: () => Option.some('Reminders'),
    Settings: () => Option.some('Settings'),
    Household: () => Option.none(),
    PushHealth: () => Option.none(),
    NotFound: () => Option.none(),
  })

const isActiveSection = (
  maybeActiveSection: Option.Option<AppSection>,
  section: AppSection,
): boolean =>
  Option.exists(maybeActiveSection, activeSection => activeSection === section)

const brandView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.a(
    [
      h.Href(todayRouter()),
      h.AriaLabel('تالی — امروز'),
      h.Class('flex shrink-0 items-center gap-2 rounded-xl px-1 py-1'),
    ],
    [
      h.span(
        [
          h.Class(
            'grid size-8 place-items-center rounded-xl bg-primary text-sm font-black text-primary-content',
          ),
        ],
        ['ت'],
      ),
      h.span(
        [h.Class('hidden text-[0.95rem] font-bold tracking-tight sm:inline')],
        ['تالی'],
      ),
    ],
  )

const desktopNavView = (maybeActiveSection: Option.Option<AppSection>): Html =>
  Nav.view({
    items: DESKTOP_SECTIONS,
    ariaLabel: 'بخش‌های تالی',
    toHref: section => NAV_ITEMS[section].href,
    isItemCurrent: section => isActiveSection(maybeActiveSection, section),
    toView: render =>
      ih.nav(
        [...render.nav, ih.Class('mx-auto hidden lg:block')],
        [
          ih.ul(
            [ih.Class('flex items-center gap-0.5')],
            Array.map(render.items, item =>
              ih.li(
                [],
                [
                  ih.a(
                    [
                      ...item.link,
                      ih.Class(
                        classNames(
                          'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.82rem] font-medium transition-colors',
                          item.isCurrent
                            ? 'bg-primary/12 text-primary'
                            : 'text-base-content/60 hover:bg-base-content/[0.04] hover:text-base-content',
                        ),
                      ),
                    ],
                    [
                      NAV_ITEMS[item.value].icon('size-4'),
                      NAV_ITEMS[item.value].label,
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
  })

const mobileLinkView = <Message>(
  item: NavItem,
  maybeActiveSection: Option.Option<AppSection>,
  h: HtmlBuilder<Message>,
): Html => {
  const isActive = isActiveSection(maybeActiveSection, item.section)

  return h.a(
    [
      h.Href(item.href),
      h.Class(
        classNames(
          'flex flex-col items-center gap-0.5 py-2 text-[0.68rem] font-medium',
          isActive ? 'text-primary' : 'text-base-content/55',
        ),
      ),
      ...(isActive ? [h.AriaCurrent('page')] : []),
    ],
    [
      h.span(
        [
          h.Class(
            classNames(
              'grid size-8 place-items-center rounded-xl',
              isActive ? 'bg-primary/10' : undefined,
            ),
          ),
        ],
        [item.icon('size-5')],
      ),
      item.label,
    ],
  )
}

const mobileMoreLinkView = <Message>(
  item: NavItem,
  maybeActiveSection: Option.Option<AppSection>,
  h: HtmlBuilder<Message>,
): Html => {
  const isActive = isActiveSection(maybeActiveSection, item.section)

  return h.a(
    [
      h.Href(item.href),
      h.Class(
        classNames(
          'flex items-center gap-2 rounded-lg px-3 py-2 text-sm',
          isActive
            ? 'bg-primary/10 text-primary'
            : 'text-base-content/80 hover:bg-base-content/5',
        ),
      ),
      ...(isActive ? [h.AriaCurrent('page')] : []),
    ],
    [item.icon('size-4'), item.label],
  )
}

export const morePanelLinkView = <Message>(
  section: AppSection,
  maybeActiveSection: Option.Option<AppSection>,
  h: HtmlBuilder<Message>,
): Html => mobileMoreLinkView(NAV_ITEMS[section], maybeActiveSection, h)

const mobileNavView = <Message>(
  config: Readonly<{
    maybeActiveSection: Option.Option<AppSection>
    moreMenu: Html
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.nav(
    [
      h.AriaLabel('نوار پایین تالی'),
      h.Class(
        'fixed inset-x-0 bottom-0 z-40 border-t border-base-300/70 bg-base-100/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden',
      ),
    ],
    [
      h.ul(
        [h.Class('mx-auto grid max-w-lg grid-cols-5')],
        [
          ...Array.map(configNavItems(), item =>
            h.li([], [mobileLinkView(item, config.maybeActiveSection, h)]),
          ),
          h.li([h.Class('w-full')], [config.moreMenu]),
        ],
      ),
    ],
  )

const configNavItems = (): ReadonlyArray<NavItem> =>
  Array.map(MOBILE_PRIMARY_SECTIONS, section => NAV_ITEMS[section])

export type ShellConfig = Readonly<{
  /** Header actions, rendered at the inline-end of the top bar. */
  actions: Html
  /** The active route's content. */
  content: Html
  /** The section the navigation highlights, if the route belongs to one. */
  maybeActiveSection: Option.Option<AppSection>
  /** The signed-in user's name, shown beside the brand on wide screens. */
  maybeDisplayName: Option.Option<string>
  /** The mobile "more" popover element, rendered in the last tab slot. */
  moreMenu: Html
}>

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
            'sticky inset-x-0 top-0 z-40 border-b border-base-300/70 bg-base-100/80 backdrop-blur-xl',
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
              Option.match(config.maybeDisplayName, {
                onNone: () => h.empty,
                onSome: displayName =>
                  h.span(
                    [
                      h.Class(
                        'me-1 hidden max-w-32 truncate text-[0.72rem] text-base-content/45 lg:inline',
                      ),
                    ],
                    [displayName],
                  ),
              }),
              desktopNavView(config.maybeActiveSection),
              h.div(
                [h.Class('ms-auto flex items-center gap-1 lg:ms-0')],
                [config.actions],
              ),
            ],
          ),
        ],
      ),
      h.main([], [config.content]),
      mobileNavView(
        {
          maybeActiveSection: config.maybeActiveSection,
          moreMenu: config.moreMenu,
        },
        h,
      ),
    ],
  )

/**
 * The full-page layout for screens that carry no section navigation: the
 * boot landing, login, register, and household onboarding.
 */

export type StandaloneConfig = Readonly<{
  /** Page-level actions, rendered in the inline-end corner. */
  actions: Html
  content: Html
}>

export const standaloneView = <Message>(
  config: StandaloneConfig,
  h: HtmlBuilder<Message>,
): Html =>
  h.main(
    [
      h.Class(
        'relative grid min-h-dvh place-items-center overflow-hidden bg-base-200 px-4 py-10',
      ),
    ],
    [
      h.div([
        h.AriaHidden(true),
        h.Class(
          'pointer-events-none absolute inset-0 bg-[radial-gradient(48rem_32rem_at_100%_0%,color-mix(in_oklch,var(--color-primary)_7%,transparent),transparent_60%),radial-gradient(40rem_24rem_at_0%_100%,color-mix(in_oklch,var(--color-secondary)_6%,transparent),transparent_60%)]',
        ),
      ]),
      h.div([h.Class('absolute end-4 top-4 z-10')], [config.actions]),
      config.content,
    ],
  )
