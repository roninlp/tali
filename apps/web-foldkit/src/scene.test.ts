import {
  Command,
  click,
  expect,
  given,
  label,
  role,
  scene,
  submit,
  text,
  type,
  within,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { ListId, NoteId } from '@tali/domain'

import * as Auth from './auth'
import type { AuthFailure } from './lib/auth-api'
import { Message, ReplaceUrl, update, view } from './main'
import * as Household from './page/household'
import * as Login from './page/login'
import * as Register from './page/register'
import * as Today from './page/today'
import { AppRoute } from './route'
import {
  failed,
  modelAt,
  sessionWithHousehold,
  sessionWithoutHousehold,
  signedIn,
  signedOut,
} from './test-fixtures'

const LIST_ID = ListId.make('018f3a4c-7b2d-7c4e-9a1b-2c3d4e5f6a7b')
const NOTE_ID = NoteId.make('018f3a4c-7b2d-7c4e-8a1b-2c3d4e5f6a7b')

const desktopNav = () => role('navigation', { name: 'بخش‌های تالی' })
const mobileNav = () => role('navigation', { name: 'نوار پایین تالی' })

const statusForRoute = (route: AppRoute): Auth.SessionStatus => {
  if (route._tag === 'Login' || route._tag === 'Register') {
    return signedOut()
  }

  if (route._tag === 'Household') {
    return signedIn(sessionWithoutHousehold)
  }

  return signedIn()
}

const routeCases: ReadonlyArray<readonly [string, AppRoute, string]> = [
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
      given(modelAt(route, statusForRoute(route))),
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
      given(modelAt(AppRoute.NotFound({ path: '/missing' }), signedOut())),
      expect(text('نشانی‌ای که باز کردید وجود ندارد.')).toExist(),
      expect(role('link', { name: 'بازگشت به تالی' })).toExist(),
    )
  })

  test('settings surfaces display preferences, the theme picker, and push health', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Settings())),
      expect(role('heading', { name: 'تنظیمات' })).toExist(),
      expect(role('heading', { name: 'ظاهر و پوسته' })).toExist(),
      expect(role('heading', { name: 'نمایش' })).toExist(),
      expect(role('heading', { name: 'وضعیت اعلان‌ها' })).toExist(),
    )
  })

  test('the push-health screen is the diagnostic panel on its own', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.PushHealth())),
      expect(role('heading', { name: 'وضعیت اعلان‌ها' })).toExist(),
      expect(text('پشتیبانی می‌شود')).toExist(),
      expect(text('بستر امن (HTTPS یا localhost)')).toExist(),
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
      given(modelAt(AppRoute.Login(), signedOut())),
      expect(desktopNav()).toBeAbsent(),
      expect(mobileNav()).toBeAbsent(),
    )
  })
})

describe('guard', () => {
  test('a signed-out visitor to a household route sees the boot screen', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Today(), signedOut())),
      expect(text('در حال بارگذاری…')).toExist(),
      expect(role('heading', { name: 'امروز' })).toBeAbsent(),
      expect(desktopNav()).toBeAbsent(),
    )
  })

  test('an account without a household is held at the onboarding screen', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Today(), signedIn(sessionWithoutHousehold))),
      expect(text('در حال بارگذاری…')).toExist(),
      expect(role('heading', { name: 'امروز' })).toBeAbsent(),
    )
  })

  test('a signed-in account on the login screen sees the boot screen', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Login(), signedIn())),
      expect(text('در حال بارگذاری…')).toExist(),
      expect(role('heading', { name: 'ورود به تالی' })).toBeAbsent(),
    )
  })

  test('the household screen offers both create and join forms', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Household(), signedIn(sessionWithoutHousehold))),
      expect(role('heading', { name: 'خانه‌ی مشترک' })).toExist(),
      expect(role('heading', { name: 'ساختن خانه' })).toExist(),
      expect(role('heading', { name: 'پیوستن به خانه' })).toExist(),
    )
  })

  test('a retried restore redirects home to the household landing', () => {
    const networkFailure: AuthFailure = {
      code: 'Network',
      retryable: true,
    }

    scene(
      { update, view },
      given(modelAt(AppRoute.Home(), failed(networkFailure))),
      expect(text('ارتباط با سرور برقرار نشد. دوباره تلاش کنید.')).toExist(),
      click(role('button', { name: 'تلاش دوباره' })),
      Command.expectExact(Auth.RestoreSession({ attempt: 2 })),
      Command.resolve(
        Auth.RestoreSession,
        Auth.Message.SucceededRestoreSession({
          attempt: 2,
          session: sessionWithHousehold,
        }),
      ),
      Command.expectHas(ReplaceUrl({ url: '/today' })),
      Command.resolve(Auth.CacheSession, Auth.Message.CompletedCacheSession()),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
      Command.resolve(
        Today.FetchToday,
        Today.Message.FailedFetchToday({
          generation: 1,
          failure: { code: 'Network', retryable: true },
        }),
      ),
      expect(role('heading', { name: 'امروز' })).toExist(),
    )
  })
})

describe('account menu', () => {
  test('the header shows the display name and the account menu', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Today())),
      expect(within(role('banner'), text('مالک'))).toExist(),
      expect(role('button', { name: 'حساب کاربری' })).toExist(),
    )
  })

  test('the theme toggle stays in the header actions', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Today())),
      expect(role('button', { name: 'حالت تیره' })).toExist(),
    )
  })

  test('the dark theme offers the switch back to light', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Today(), signedIn(), 'talidark')),
      expect(role('button', { name: 'حالت روشن' })).toExist(),
    )
  })
})

describe('login flow', () => {
  test('a successful login lands on today and caches the session', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Login(), signedOut())),
      type(label('ایمیل'), 'owner@example.com'),
      type(label('گذرواژه'), 'correct horse battery'),
      submit(role('form')),
      Command.expectExact(Login.SubmitLogin),
      Command.resolve(
        Login.SubmitLogin,
        Login.Message.SucceededLogin({ session: sessionWithHousehold }),
      ),
      Command.expectHas(ReplaceUrl({ url: '/today' })),
      Command.resolve(Auth.CacheSession, Auth.Message.CompletedCacheSession()),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
      Command.resolve(
        Today.FetchToday,
        Today.Message.FailedFetchToday({
          generation: 1,
          failure: { code: 'Network', retryable: true },
        }),
      ),
      expect(role('heading', { name: 'امروز' })).toExist(),
    )
  })

  test('registration without a household lands on onboarding', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Register(), signedOut())),
      type(label('نام نمایشی'), 'مالک'),
      type(label('ایمیل'), 'owner@example.com'),
      type(label('گذرواژه'), 'correct horse battery'),
      submit(role('form')),
      Command.expectExact(Register.SubmitRegistration),
      Command.resolve(
        Register.SubmitRegistration,
        Register.Message.SucceededRegister({
          session: sessionWithoutHousehold,
        }),
      ),
      Command.expectHas(ReplaceUrl({ url: '/household' })),
      Command.resolve(Auth.CacheSession, Auth.Message.CompletedCacheSession()),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
      expect(role('heading', { name: 'خانه‌ی مشترک' })).toExist(),
    )
  })
})

describe('household onboarding', () => {
  test('creating a household shows the invite, then opens today', () => {
    scene(
      { update, view },
      given(modelAt(AppRoute.Household(), signedIn(sessionWithoutHousehold))),
      click(role('button', { name: 'ساختن خانه' })),
      Command.expectExact(
        Household.SubmitCreateHousehold({ name: 'خانه‌ی ما' }),
      ),
      Command.resolve(
        Household.SubmitCreateHousehold,
        Household.Message.SucceededCreateHousehold({
          household: {
            id: '0192f0a0-0000-7000-8000-000000000002',
            name: 'خانه‌ی ما',
            inviteCode: 'invite-code',
          },
        }),
      ),
      Command.expectHas(Auth.CacheSession),
      Command.resolve(Auth.CacheSession, Auth.Message.CompletedCacheSession()),
      expect(role('heading', { name: 'خانه ساخته شد' })).toExist(),
      click(role('button', { name: 'ادامه به امروز' })),
      Command.expectHas(ReplaceUrl({ url: '/today' })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
      Command.resolve(
        Today.FetchToday,
        Today.Message.FailedFetchToday({
          generation: 1,
          failure: { code: 'Network', retryable: true },
        }),
      ),
      expect(role('heading', { name: 'امروز' })).toExist(),
    )
  })
})
