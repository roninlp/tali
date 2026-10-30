import { Option } from 'effect'
import { beforeEach, describe, expect, test } from 'vitest'

import { sessionWithHousehold } from '../test-fixtures'
import {
  cacheSession,
  clearCachedSession,
  readCachedSession,
} from './session-cache'

describe('session cache', () => {
  beforeEach(() => {
    clearCachedSession()
  })

  test('round-trips the public session context', () => {
    cacheSession(sessionWithHousehold)

    expect(readCachedSession()).toStrictEqual(Option.some(sessionWithHousehold))
  })

  test('returns none for malformed or foreign shapes', () => {
    localStorage.setItem('tali.session.v1', '{not json')
    expect(readCachedSession()).toStrictEqual(Option.none())

    localStorage.setItem(
      'tali.session.v1',
      JSON.stringify({ user: { id: 'x' } }),
    )
    expect(readCachedSession()).toStrictEqual(Option.none())
  })

  test('clears on demand', () => {
    cacheSession(sessionWithHousehold)
    clearCachedSession()

    expect(readCachedSession()).toStrictEqual(Option.none())
  })
})
