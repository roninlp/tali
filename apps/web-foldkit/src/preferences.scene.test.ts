import { Option } from 'effect'
import {
  Command,
  expect,
  given,
  label,
  role,
  scene,
  submit,
  text,
  type,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import * as Preferences from './preferences'
import {
  Preferences as PreferencesRow,
  defaultPreferences,
  displayFieldsOf,
} from './preferences-model'
import { USER_ID, preferencesModel } from './test-fixtures'

const row = (overrides: Partial<PreferencesRow> = {}): PreferencesRow =>
  PreferencesRow.make({
    ...defaultPreferences(USER_ID, {
      timeZone: 'Europe/Berlin',
      weekStart: 'monday',
      digits: 'latin',
    }),
    ...overrides,
  })

const adoptedModel = (preferences: PreferencesRow = row()): Preferences.Model =>
  preferencesModel({
    maybePreferences: Option.some(preferences),
    defaults: displayFieldsOf(preferences),
    draft: displayFieldsOf(preferences),
    source: 'Server',
  })

describe('display preferences panel', () => {
  test('shows the confirmed values and where they came from', () => {
    scene(
      { update: Preferences.update, view: Preferences.settingsView },
      given(adoptedModel()),
      expect(role('heading', { name: 'نمایش' })).toExist(),
      expect(text('همگام با سرور')).toExist(),
      expect(label('منطقه‌ی زمانی (IANA)')).toHaveValue('Europe/Berlin'),
      expect(label('شروع هفته')).toHaveValue('monday'),
      expect(label('شکل اعداد')).toHaveValue('latin'),
    )
  })

  test('an offline cache is labelled honestly', () => {
    scene(
      { update: Preferences.update, view: Preferences.settingsView },
      given(
        preferencesModel({
          source: 'Cache',
          maybePreferences: Option.some(row()),
          draft: displayFieldsOf(row()),
        }),
      ),
      expect(text('از حافظه‌ی محلی')).toExist(),
    )
  })

  test('saving a changed zone sends only that field', () => {
    scene(
      { update: Preferences.update, view: Preferences.settingsView },
      given(adoptedModel()),
      type(label('منطقه‌ی زمانی (IANA)'), 'Europe/Paris'),
      submit(role('form')),
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
          preferences: row({ timeZone: 'Europe/Paris' }),
        }),
      ),
      Command.resolve(
        Preferences.CachePreferences,
        Preferences.Message.CompletedCachePreferences(),
      ),
      expect(text('تنظیمات نمایش ذخیره شد.')).toExist(),
    )
  })

  test('an invalid IANA zone is caught before the request', () => {
    scene(
      { update: Preferences.update, view: Preferences.settingsView },
      given(adoptedModel()),
      type(label('منطقه‌ی زمانی (IANA)'), 'Mars/Olympus'),
      submit(role('form')),
      expect(
        role('alert', {
          name: 'منطقه‌ی زمانی معتبر نیست؛ مثل Asia/Tehran وارد کنید.',
        }),
      ).toExist(),
      Command.expectNone(),
    )
  })
})
