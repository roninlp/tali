import { Option } from 'effect'
import { beforeEach, describe, expect, test } from 'vitest'

import { Preferences, defaultPreferences } from '../preferences-model'
import {
  cachePreferences,
  clearCachedPreferences,
  readCachedPreferences,
} from './preferences-cache'

const USER_A = '0192f0a0-0000-7000-8000-00000000000a'
const USER_B = '0192f0a0-0000-7000-8000-00000000000b'

const preferencesFor = (
  userId: string,
  overrides: Partial<Preferences> = {},
): Preferences =>
  Preferences.make({ ...defaultPreferences(userId), ...overrides })

const read = (userId: string) =>
  Option.match(readCachedPreferences(userId), {
    onNone: () => undefined,
    onSome: preferences => preferences,
  })

describe('preferences cache', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('round-trips the last server-confirmed preferences per user', () => {
    const saved = preferencesFor(USER_A, {
      timeZone: 'Europe/Berlin',
      weekStart: 'monday',
      digits: 'latin',
      dashboardSectionOrder: [
        'notes',
        'tasks',
        'events',
        'reminders',
        'habits',
      ],
      checkedItemPlacement: 'inPlace',
    })

    cachePreferences(saved)
    expect(read(USER_A)).toStrictEqual(saved)
  })

  test('keeps two users on one browser isolated', () => {
    cachePreferences(
      preferencesFor(USER_A, { weekStart: 'monday', digits: 'latin' }),
    )
    cachePreferences(preferencesFor(USER_B, { weekStart: 'sunday' }))

    expect(read(USER_A)?.weekStart).toBe('monday')
    expect(read(USER_B)?.weekStart).toBe('sunday')
    expect(read(USER_B)?.digits).toBe('persian')
  })

  test('ignores malformed, foreign or impossible cached shapes', () => {
    localStorage.setItem(`tali.preferences.v1.${USER_A}`, '{not json')
    expect(read(USER_A)).toBeUndefined()

    localStorage.setItem(
      `tali.preferences.v1.${USER_A}`,
      JSON.stringify({ userId: USER_A, weekStart: 'tuesday' }),
    )
    expect(read(USER_A)).toBeUndefined()

    expect(read(USER_B)).toBeUndefined()
  })

  test('clears one user without touching the other', () => {
    cachePreferences(preferencesFor(USER_A))
    cachePreferences(preferencesFor(USER_B))

    clearCachedPreferences(USER_A)
    expect(read(USER_A)).toBeUndefined()
    expect(read(USER_B)).toBeDefined()
  })
})
