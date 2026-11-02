import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { fromString } from 'foldkit/url'
import { describe, expect, test } from 'vitest'

import { InviteCode } from '@tali/domain'

import { HouseholdSummary } from './household-summary'
import type { AuthFailure } from './lib/auth-api'
import { Message, ReplaceUrl, update } from './main'
import * as Household from './page/household'
import * as Today from './page/today'
import { AppRoute } from './route'
import {
  failed,
  modelAt,
  restoring,
  sessionWithoutHousehold,
  signedIn,
  signedOut,
} from './test-fixtures'

const url = (path: string) =>
  Option.getOrThrowWith(
    fromString(`http://localhost${path}`),
    () => new Error(`Failed to parse url: ${path}`),
  )

const changedUrl = (path: string) =>
  message(Message.ChangedUrl({ url: url(path) }))

const networkFailure: AuthFailure = { code: 'Network', retryable: true }

describe('guard redirects', () => {
  test('a signed-out visitor to a household route lands on login', () => {
    story(
      update,
      given(modelAt(AppRoute.Today(), signedOut())),
      changedUrl('/today'),
      model(model => {
        expect(model.route).toStrictEqual(AppRoute.Login())
      }),
      Command.expectExact(ReplaceUrl({ url: '/login' })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
    )
  })

  test('the home route sends a signed-in household member to today', () => {
    story(
      update,
      given(modelAt(AppRoute.Home(), signedIn())),
      changedUrl('/'),
      model(model => {
        expect(model.route).toStrictEqual(AppRoute.Today())
      }),
      Command.expectExact(
        Today.FetchToday({
          generation: 1,
          maybeEtag: Option.none(),
          dirtyAtRequest: [],
        }),
        ReplaceUrl({ url: '/today' }),
      ),
      Command.resolve(
        Today.FetchToday,
        Today.Message.FailedFetchToday({
          generation: 1,
          failure: { code: 'Network', retryable: true },
        }),
      ),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
    )
  })

  test('the home route sends an account without a household to onboarding', () => {
    story(
      update,
      given(modelAt(AppRoute.Home(), signedIn(sessionWithoutHousehold))),
      changedUrl('/'),
      model(model => {
        expect(model.route).toStrictEqual(AppRoute.Household())
      }),
      Command.expectExact(ReplaceUrl({ url: '/household' })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
    )
  })

  test('a signed-in account on the login screen lands on its home screen', () => {
    story(
      update,
      given(modelAt(AppRoute.Login(), signedIn())),
      changedUrl('/login'),
      model(model => {
        expect(model.route).toStrictEqual(AppRoute.Today())
      }),
      Command.expectExact(
        Today.FetchToday({
          generation: 1,
          maybeEtag: Option.none(),
          dirtyAtRequest: [],
        }),
        ReplaceUrl({ url: '/today' }),
      ),
      Command.resolve(
        Today.FetchToday,
        Today.Message.FailedFetchToday({
          generation: 1,
          failure: { code: 'Network', retryable: true },
        }),
      ),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
    )
  })

  test('a household route without a household sends the account to onboarding', () => {
    story(
      update,
      given(modelAt(AppRoute.Tasks(), signedIn(sessionWithoutHousehold))),
      changedUrl('/tasks'),
      model(model => {
        expect(model.route).toStrictEqual(AppRoute.Household())
      }),
      Command.expectExact(ReplaceUrl({ url: '/household' })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
    )
  })

  test('an account that already has a household cannot reopen onboarding', () => {
    story(
      update,
      given(modelAt(AppRoute.Household(), signedIn())),
      changedUrl('/household'),
      model(model => {
        expect(model.route).toStrictEqual(AppRoute.Today())
      }),
      Command.expectExact(
        Today.FetchToday({
          generation: 1,
          maybeEtag: Option.none(),
          dirtyAtRequest: [],
        }),
        ReplaceUrl({ url: '/today' }),
      ),
      Command.resolve(
        Today.FetchToday,
        Today.Message.FailedFetchToday({
          generation: 1,
          failure: { code: 'Network', retryable: true },
        }),
      ),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
    )
  })

  test('settings is available to an account without a household', () => {
    story(
      update,
      given(modelAt(AppRoute.Today(), signedIn(sessionWithoutHousehold))),
      changedUrl('/settings'),
      model(model => {
        expect(model.route).toStrictEqual(AppRoute.Settings())
      }),
      Command.expectNone(),
    )
  })

  test('a signed-out visitor to onboarding lands on login', () => {
    story(
      update,
      given(modelAt(AppRoute.Today(), signedOut())),
      changedUrl('/household'),
      model(model => {
        expect(model.route).toStrictEqual(AppRoute.Login())
      }),
      Command.expectExact(ReplaceUrl({ url: '/login' })),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
    )
  })

  test('the guard waits while the session restores', () => {
    story(
      update,
      given(modelAt(AppRoute.Home(), restoring())),
      changedUrl('/today'),
      model(model => {
        expect(model.route).toStrictEqual(AppRoute.Today())
      }),
      Command.expectNone(),
    )
  })

  test('the guard waits after a failed restore instead of bouncing to login', () => {
    story(
      update,
      given(modelAt(AppRoute.Home(), failed(networkFailure))),
      changedUrl('/today'),
      model(model => {
        expect(model.route).toStrictEqual(AppRoute.Today())
      }),
      Command.expectNone(),
    )
  })

  test('a not-found page renders for a signed-out visitor', () => {
    story(
      update,
      given(modelAt(AppRoute.Home(), signedOut())),
      changedUrl('/missing'),
      model(model => {
        expect(model.route).toStrictEqual(
          AppRoute.NotFound({ path: '/missing' }),
        )
      }),
      Command.expectNone(),
    )
  })

  test('the invite panel keeps onboarding open after creating a household', () => {
    const withInvite = modifyFields(modelAt(AppRoute.Household(), signedIn()), {
      household: () =>
        modifyFields(Household.initialModel(), {
          maybeCreated: () =>
            Option.some(
              HouseholdSummary.make({
                id: '0192f0a0-0000-7000-8000-000000000002',
                name: 'خانه‌ی ما',
                inviteCode: InviteCode.make('invite-code'),
              }),
            ),
        }),
    })

    story(
      update,
      given(withInvite),
      changedUrl('/household'),
      model(model => {
        expect(model.route).toStrictEqual(AppRoute.Household())
      }),
      Command.expectNone(),
    )
  })
})
