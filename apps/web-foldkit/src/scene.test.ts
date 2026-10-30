import { expect, given, role, scene, text, within } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { ListId, NoteId } from '@tali/domain'

import { Model, update, view } from './main'
import { AppRoute } from './route'
import * as Theme from './theme'

const LIST_ID = ListId.make('018f3a4c-7b2d-7c4e-9a1b-2c3d4e5f6a7b')
const NOTE_ID = NoteId.make('018f3a4c-7b2d-7c4e-8a1b-2c3d4e5f6a7b')

const modelAt = (route: AppRoute, theme: Theme.Theme = 'Tali'): Model =>
  Model.make({
    route,
    theme: Theme.Model.make({ theme }),
  })

const desktopNav = () => role('navigation', { name: 'بخش‌های تالی' })
const mobileNav = () => role('navigation', { name: 'نوار پایین تالی' })

const routeCases: ReadonlyArray<readonly [string, AppRoute, string]> = [
  ['Home', AppRoute.Home(), 'تالی'],
  ['Login', AppRoute.Login(), 'ورود به تالی'],
  ['Register', AppRoute.Register(), 'ساخت حساب'],
  ['Today', AppRoute.Today(), 'امروز'],
  ['Tasks', AppRoute.Tasks(), 'کارها'],
  ['Lists', AppRoute.Lists(), 'فهرست‌ها'],
  ['List', AppRoute.List({ listId: LIST_ID }), 'فهرست'],
  ['Notes', AppRoute.Notes(), 'یادداشت‌ها'],
  ['Note', AppRoute.Note({ noteId: NOTE_ID }), 'یادداشت'],
  ['NotesTrash', AppRoute.NotesTrash(), 'سطل زباله'],
  ['Habits', AppRoute.Habits(), 'عادت‌ها'],
  ['Calendar', AppRoute.Calendar(), 'تقویم'],
  ['Reminders', AppRoute.Reminders(), 'یادآورها'],
  ['Settings', AppRoute.Settings(), 'تنظیمات'],
  ['Household', AppRoute.Household(), 'خانه‌ی مشترک'],
  ['PushHealth', AppRoute.PushHealth(), 'وضعیت اعلان‌ها'],
  ['NotFound', AppRoute.NotFound({ path: '/missing' }), 'صفحه پیدا نشد'],
]

describe('route placeholders', () => {
  test.each(routeCases)('%s renders its heading', (_label, route, heading) => {
    scene(
      { update, view },
      given(modelAt(route)),
      expect(role('heading', { name: heading })).toExist(),
    )
  })

  test('a list detail shows the id captured by the router', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.List({ listId: LIST_ID }))),
      expect(text(`شناسه‌ی فهرست: ${LIST_ID}`)).toExist(),
    )
  })

  test('a note detail shows the id captured by the router', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Note({ noteId: NOTE_ID }))),
      expect(text(`شناسه‌ی یادداشت: ${NOTE_ID}`)).toExist(),
    )
  })

  test('the not-found view offers a way home', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.NotFound({ path: '/missing' }))),
      expect(text('نشانی‌ای که باز کردید وجود ندارد.')).toExist(),
      expect(role('link', { name: 'بازگشت به تالی' })).toExist(),
    )
  })
})

describe('navigation', () => {
  test('the signed-in shell links the brand to today', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Today())),
      expect(role('link', { name: 'تالی — امروز' })).toExist(),
    )
  })

  test('the desktop nav marks the current section', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Tasks())),
      expect(within(desktopNav(), role('link', { name: 'کارها' }))).toHaveAttr(
        'aria-current',
        'page',
      ),
      expect(
        within(desktopNav(), role('link', { name: 'امروز' })),
      ).not.toHaveAttr('aria-current', 'page'),
    )
  })

  test('a list detail keeps the lists section active', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.List({ listId: LIST_ID }))),
      expect(
        within(desktopNav(), role('link', { name: 'فهرست‌ها' })),
      ).toHaveAttr('aria-current', 'page'),
    )
  })

  test('the mobile tab bar marks the current section', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Calendar())),
      expect(within(mobileNav(), role('link', { name: 'تقویم' }))).toHaveAttr(
        'aria-current',
        'page',
      ),
      expect(
        within(mobileNav(), role('link', { name: 'امروز' })),
      ).not.toHaveAttr('aria-current', 'page'),
    )
  })

  test('the mobile more menu links the secondary sections', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Habits())),
      expect(within(mobileNav(), role('link', { name: 'عادت‌ها' }))).toHaveAttr(
        'aria-current',
        'page',
      ),
      expect(within(mobileNav(), role('link', { name: 'فهرست‌ها' }))).toExist(),
      expect(within(mobileNav(), role('link', { name: 'تنظیمات' }))).toExist(),
    )
  })

  test('auth screens render outside the app shell', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Login())),
      expect(desktopNav()).toBeAbsent(),
      expect(mobileNav()).toBeAbsent(),
    )
  })
})

describe('theme', () => {
  test('the header offers the switch to the dark theme', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Today())),
      expect(role('button', { name: 'حالت تیره' })).toExist(),
    )
  })

  test('the dark theme offers the switch back to light', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Today(), 'TaliDark')),
      expect(role('button', { name: 'حالت روشن' })).toExist(),
    )
  })
})
