import { Option } from 'effect'
import { beforeEach, describe, expect, test } from 'vitest'

import {
  loadCaptureText,
  saveCaptureText,
} from '../lib/capture-draft-cache'
import { initialModel } from './capture'

/**
 * The Capture composer's crash-safe text cache (ADR-0012 §10).
 *
 * A failed Dissect, a reload or a crash must not lose the thought: the text is
 * in the Model and in localStorage keyed by user id.
 */

const USER = 'user-a'

describe('capture text cache', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('round-trips the composer text per user', () => {
    saveCaptureText(USER, 'فردا دکتر')
    expect(loadCaptureText(USER)).toBe('فردا دکتر')
    expect(loadCaptureText('user-b')).toBe('')
  })

  test('an empty save removes the key', () => {
    saveCaptureText(USER, 'فردا دکتر')
    saveCaptureText(USER, '')
    expect(loadCaptureText(USER)).toBe('')
  })

  test('the page model starts from the cached text', () => {
    saveCaptureText(USER, 'فردا ساعت ۵ دکتر')
    const model = initialModel({ maybeUserId: Option.some(USER) })
    expect(model.text).toBe('فردا ساعت ۵ دکتر')
  })
})
