import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import * as Preferences from './preferences'
import {
  DisplayFields,
  Preferences as PreferencesRow,
  changedDisplayFields,
  defaultPreferences,
  displayFieldsOf,
} from './preferences-model'
import { USER_ID, preferencesModel } from './test-fixtures'

const OTHER_USER_ID = '0192f0a0-0000-7000-8000-000000000099'

const savedRow = (overrides: Partial<PreferencesRow> = {}): PreferencesRow =>
  PreferencesRow.make({
    ...defaultPreferences(USER_ID, {
      timeZone: 'Europe/Berlin',
      weekStart: 'monday',
      digits: 'latin',
    }),
    ...overrides,
  })

const adoptedModel = (row: PreferencesRow = savedRow()): Preferences.Model =>
  preferencesModel({
    maybePreferences: Option.some(row),
    defaults: displayFieldsOf(row),
    draft: displayFieldsOf(row),
    source: 'Server',
  })

describe('cache adoption', () => {
  test('init adopts the cached row before the network settles', () => {
    const cached = savedRow()
    const init = Preferences.init({
      maybeUserId: Option.some(USER_ID),
      maybeProfileDefaults: Option.none(),
      maybeCachedPreferences: Option.some(cached),
    })

    expect(init.model.source).toBe('Cache')
    expect(init.model.draft).toStrictEqual(displayFieldsOf(cached))
    expect(init.commands).toBeDefined()
  })

  test('a sign-in reads the cache, then reconciles with the server', () => {
    const cached = savedRow()

    story(
      Preferences.update,
      given(
        preferencesModel({
          maybeUserId: Option.some(USER_ID),
          maybePreferences: Option.none(),
        }),
      ),
      message(
        Preferences.Message.CompletedReadCachedPreferences({
          userId: USER_ID,
          maybePreferences: Option.some(cached),
        }),
      ),
      model(next => {
        expect(next.source).toBe('Cache')
        expect(next.draft).toStrictEqual(displayFieldsOf(cached))
      }),
      Command.expectExact(Preferences.FetchPreferences({ userId: USER_ID })),
      Command.resolve(
        Preferences.FetchPreferences,
        Preferences.Message.SucceededFetchPreferences({
          userId: USER_ID,
          preferences: cached,
        }),
      ),
      Command.expectHas(Preferences.CachePreferences({ preferences: cached })),
      Command.resolve(
        Preferences.CachePreferences,
        Preferences.Message.CompletedCachePreferences(),
      ),
      model(next => {
        expect(next.source).toBe('Server')
      }),
    )
  })

  test('a cache miss keeps the profile defaults and still asks the server', () => {
    story(
      Preferences.update,
      given(preferencesModel()),
      message(
        Preferences.Message.CompletedReadCachedPreferences({
          userId: USER_ID,
          maybePreferences: Option.none(),
        }),
      ),
      model(next => {
        expect(next.source).toBe('Default')
        expect(next.draft.timeZone).toBe('Asia/Tehran')
      }),
      Command.expectExact(Preferences.FetchPreferences({ userId: USER_ID })),
      Command.resolve(
        Preferences.FetchPreferences,
        Preferences.Message.FailedFetchPreferences({
          userId: USER_ID,
          failure: { code: 'Network', retryable: true },
        }),
      ),
    )
  })
})

describe('server reconciliation', () => {
  test('a successful load adopts the row, clears the error, and caches it', () => {
    const row = savedRow()

    story(
      Preferences.update,
      given(
        preferencesModel({
          maybeError: Option.some('ارتباط با سرور برقرار نشد.'),
        }),
      ),
      message(
        Preferences.Message.SucceededFetchPreferences({
          userId: USER_ID,
          preferences: row,
        }),
      ),
      model(next => {
        expect(next.maybePreferences).toStrictEqual(Option.some(row))
        expect(next.draft).toStrictEqual(displayFieldsOf(row))
        expect(next.source).toBe('Server')
        expect(next.maybeError).toStrictEqual(Option.none())
      }),
      Command.expectExact(Preferences.CachePreferences({ preferences: row })),
      Command.resolve(
        Preferences.CachePreferences,
        Preferences.Message.CompletedCachePreferences(),
      ),
    )
  })

  test('a load for a previous user never paints another account settings', () => {
    const row = savedRow()

    story(
      Preferences.update,
      given(
        preferencesModel({
          maybeUserId: Option.some(OTHER_USER_ID),
          source: 'Server',
        }),
      ),
      message(
        Preferences.Message.SucceededFetchPreferences({
          userId: USER_ID,
          preferences: row,
        }),
      ),
      model(next => {
        expect(next.maybeUserId).toStrictEqual(Option.some(OTHER_USER_ID))
        expect(next.maybePreferences).toStrictEqual(Option.none())
        expect(next.source).toBe('Server')
      }),
      Command.expectExact(Preferences.CachePreferences({ preferences: row })),
      Command.resolve(
        Preferences.CachePreferences,
        Preferences.Message.CompletedCachePreferences(),
      ),
    )
  })

  test('a failed load keeps the cached values and records the error', () => {
    const cached = savedRow()

    story(
      Preferences.update,
      given(adoptedModel(cached)),
      message(
        Preferences.Message.FailedFetchPreferences({
          userId: USER_ID,
          failure: { code: 'Network', retryable: true },
        }),
      ),
      model(next => {
        expect(next.maybePreferences).toStrictEqual(Option.some(cached))
        expect(next.draft).toStrictEqual(displayFieldsOf(cached))
        expect(next.maybeError).toStrictEqual(
          Option.some(
            'ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی کنید.',
          ),
        )
      }),
      Command.expectNone(),
    )
  })
})

describe('display settings save', () => {
  test('only the changed field is patched', () => {
    const row = savedRow()

    story(
      Preferences.update,
      given(adoptedModel(row)),
      message(
        Preferences.Message.UpdatedTimeZoneDraft({
          value: 'Europe/Paris',
        }),
      ),
      message(Preferences.Message.SubmittedDisplayPreferences()),
      model(next => {
        expect(next.isSaving).toBe(true)
        expect(next.draft.timeZone).toBe('Europe/Paris')
      }),
      Command.expectExact(
        Preferences.SavePreferences({
          userId: USER_ID,
          patch: { timeZone: 'Europe/Paris' },
        }),
      ),
      Command.resolve(
        Preferences.SavePreferences,
        Preferences.Message.SucceededSavePreferences({
          userId: USER_ID,
          preferences: savedRow({ timeZone: 'Europe/Paris' }),
        }),
      ),
      Command.expectHas(
        Preferences.CachePreferences({
          preferences: savedRow({ timeZone: 'Europe/Paris' }),
        }),
      ),
      Command.resolve(
        Preferences.CachePreferences,
        Preferences.Message.CompletedCachePreferences(),
      ),
      model(next => {
        expect(next.isSaving).toBe(false)
        expect(next.hasSaved).toBe(true)
        expect(next.source).toBe('Server')
      }),
    )
  })

  test('an empty patch still asks for the authoritative row', () => {
    story(
      Preferences.update,
      given(adoptedModel()),
      message(Preferences.Message.SubmittedDisplayPreferences()),
      Command.expectExact(
        Preferences.SavePreferences({ userId: USER_ID, patch: {} }),
      ),
      Command.resolve(
        Preferences.SavePreferences,
        Preferences.Message.SucceededSavePreferences({
          userId: USER_ID,
          preferences: savedRow(),
        }),
      ),
      Command.resolve(
        Preferences.CachePreferences,
        Preferences.Message.CompletedCachePreferences(),
      ),
    )
  })

  test('an invalid IANA zone is rejected before any request', () => {
    story(
      Preferences.update,
      given(adoptedModel()),
      message(
        Preferences.Message.UpdatedTimeZoneDraft({ value: 'Mars/Olympus' }),
      ),
      message(Preferences.Message.SubmittedDisplayPreferences()),
      model(next => {
        expect(next.isSaving).toBe(false)
        expect(next.maybeError).toStrictEqual(
          Option.some('منطقه‌ی زمانی معتبر نیست؛ مثل Asia/Tehran وارد کنید.'),
        )
      }),
      Command.expectNone(),
    )
  })

  test('a failed save keeps the confirmed value and shows the failure', () => {
    const row = savedRow()

    story(
      Preferences.update,
      given(adoptedModel(row)),
      message(Preferences.Message.UpdatedDigitsDraft({ value: 'persian' })),
      message(Preferences.Message.SubmittedDisplayPreferences()),
      Command.resolve(
        Preferences.SavePreferences,
        Preferences.Message.FailedSavePreferences({
          userId: USER_ID,
          failure: { code: 'Network', retryable: true },
        }),
      ),
      model(next => {
        expect(next.isSaving).toBe(false)
        expect(next.maybePreferences).toStrictEqual(Option.some(row))
        expect(next.source).toBe('Server')
        expect(next.maybeError).toStrictEqual(
          Option.some(
            'ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی کنید.',
          ),
        )
      }),
      Command.expectNone(),
    )
  })
})

describe('session changes', () => {
  test('a new account reads its own cache and a sign-out resets the drafts', () => {
    const signedOut = preferencesModel({ maybeUserId: Option.none() })
    const signedIn = Preferences.applySession(
      signedOut,
      Option.some({
        userId: USER_ID,
        defaults: {
          timeZone: 'Europe/Berlin',
          weekStart: 'monday',
          digits: 'latin',
        },
      }),
    )

    expect(signedIn.model.maybeUserId).toStrictEqual(Option.some(USER_ID))
    expect(signedIn.model.defaults.timeZone).toBe('Europe/Berlin')
    expect(signedIn.commands).toBeDefined()

    const cleared = Preferences.applySession(signedIn.model, Option.none())

    expect(cleared.model.maybeUserId).toStrictEqual(Option.none())
    expect(cleared.model.source).toBe('Default')
    expect(cleared.model.draft.timeZone).toBe('Asia/Tehran')
    expect(cleared.model.maybePreferences).toStrictEqual(Option.none())
  })
})

describe('changedDisplayFields', () => {
  const saved: DisplayFields = {
    timeZone: 'Asia/Tehran',
    weekStart: 'monday',
    digits: 'latin',
  }

  test('sends only the fields the user changed', () => {
    expect(
      changedDisplayFields(saved, { ...saved, timeZone: 'Europe/Berlin' }),
    ).toStrictEqual({ timeZone: 'Europe/Berlin' })
    expect(
      changedDisplayFields(saved, { ...saved, digits: 'persian' }),
    ).toStrictEqual({ digits: 'persian' })
  })

  test('sends an empty patch when the drafts match the confirmed value', () => {
    expect(changedDisplayFields(saved, { ...saved })).toStrictEqual({})
  })

  test('sends every changed field together', () => {
    expect(
      changedDisplayFields(saved, {
        timeZone: 'Europe/Berlin',
        weekStart: 'saturday',
        digits: 'latin',
      }),
    ).toStrictEqual({ timeZone: 'Europe/Berlin', weekStart: 'saturday' })
  })
})
