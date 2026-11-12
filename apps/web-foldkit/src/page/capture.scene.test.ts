import { Option } from 'effect'
import { expect, given, role, scene, text, withViewInputs } from 'foldkit/scene'
import { describe, test } from 'vitest'

import {
  type Capture,
  type CaptureCommitResult,
  type CaptureDraft,
  CaptureId,
  TimestampUtc,
  UserId,
  eventCaptureDraft,
  needsInput,
  taskCaptureDraft,
  timedEventTiming,
} from '@tali/domain'

import { DISPLAY, USER_ID } from '../test-fixtures'
import * as CapturePage from './capture'
import type { Inputs, Model } from './capture'

/**
 * The `/capture` view (ticket #101).
 *
 * The review card's trust signal is the verbatim Source Quote; the commit is
 * visibly blocked while a Needs Input is open; the result strip names what was
 * created. These are the three promises the screen makes.
 */

const inputs = (overrides: Partial<Inputs> = {}): Inputs => ({
  display: DISPLAY,
  isOnline: true,
  maybeUserId: Option.some(USER_ID),
  today: '2026-11-09',
  ...overrides,
})

const setup = (overrides: Partial<Inputs> = {}) => {
  const viewInputs = inputs(overrides)

  return {
    update: (capture: Model, message: CapturePage.Message) =>
      CapturePage.update(capture, message, viewInputs),
    view: withViewInputs(CapturePage.view, viewInputs)(),
  }
}

const taskDraft: CaptureDraft = taskCaptureDraft({
  title: 'خرید نان',
  sourceQuote: 'خرید نان',
  missing: [],
})

const blockedDraft: CaptureDraft = eventCaptureDraft({
  title: 'دکتر',
  sourceQuote: 'فردا دکتر',
  missing: [needsInput('timing', 'localDate', 'این رویداد چه روزی است؟')],
})

const cardOf = (draft: CaptureDraft): CapturePage.CaptureCard =>
  CapturePage.CaptureCard.make({
    cardId: `card-${draft._tag}`,
    draft,
    title: draft.title ?? '',
    isDiscarded: false,
  })

const captureOf = (overrides: Partial<Capture> = {}): Capture => ({
  id: CaptureId.make('0192f0a0-0000-7000-8000-000000000010'),
  ownerId: UserId.make(USER_ID),
  text: 'خرید نان',
  status: 'parsed',
  drafts: [taskDraft],
  createdIds: [],
  error: null,
  createdAt: '2026-11-08T09:00:00.000Z',
  committedAt: null,
  ...overrides,
})

const resultOf = (): CaptureCommitResult => ({
  capture: captureOf({ status: 'committed' }),
  created: [{ type: 'task', id: 'task-1', title: 'خرید نان' }],
  failure: null,
  remaining: 0,
})

const model = (overrides: Partial<Model> = {}): Model => ({
  ...CapturePage.initialModel({ maybeUserId: Option.some(USER_ID) }),
  ...overrides,
})

describe('capture view', () => {
  test('the composer explains the network requirement offline', () => {
    scene(
      setup({ isOnline: false }),
      given(model({ text: 'فردا دکتر' })),
      expect(role('heading', { name: 'کپچر' })).toExist(),
      expect(text(/کپچر به اینترنت نیاز دارد/)).toExist(),
      expect(role('button', { name: 'تجزیه' })).toExist(),
    )
  })

  test('a card shows its source quote and a blocked Needs Input', () => {
    scene(
      setup(),
      given(
        model({
          phase: 'review',
          cards: [cardOf(blockedDraft)],
          maybeCaptureId: Option.some(captureOf().id),
        }),
      ),
      expect(text('«فردا دکتر»')).toExist(),
      expect(text('این رویداد چه روزی است؟')).toExist(),
      expect(text(/تا وقتی Needs Input یک کارت پاسخ داده نشده/)).toExist(),
    )
  })

  test('a malformed instant renders instead of crashing the screen', () => {
    const broken: CaptureDraft = eventCaptureDraft({
      title: 'جلسه',
      sourceQuote: 'جلسه',
      timing: timedEventTiming(
        TimestampUtc.make('17:00'),
        TimestampUtc.make('18:00'),
      ),
      missing: [],
    })

    scene(
      setup(),
      given(model({ phase: 'review', cards: [cardOf(broken)] })),
      expect(role('heading', { name: 'کپچر' })).toExist(),
      expect(text('«جلسه»')).toExist(),
    )
  })

  test('a clock-time Needs Input renders a time picker when the day is known', () => {
    const event: CaptureDraft = eventCaptureDraft({
      title: 'جلسه',
      sourceQuote: 'سه شنبه جلسه',
      timing: timedEventTiming(
        TimestampUtc.make('2026-11-10T12:30:00.000Z'),
        TimestampUtc.make('2026-11-10T13:30:00.000Z'),
      ),
      timeZone: 'Asia/Tehran',
      missing: [needsInput('timing.start', 'clockTime', 'ساعت شروع؟')],
    })

    scene(
      setup(),
      given(model({ phase: 'review', cards: [cardOf(event)] })),
      expect(text('ساعت شروع؟')).toExist(),
      expect(role('button', { name: /^ساعت شروع؟/ })).toExist(),
    )
  })

  test('a failed history row offers a retry and its error', () => {
    const failed = captureOf({
      status: 'failed',
      error: 'مدل در ۶۰ ثانیه پاسخ نداد',
      drafts: [],
    })

    scene(
      setup(),
      given(
        model({
          history: [failed],
          expandedHistoryId: Option.some(failed.id),
        }),
      ),
      expect(text('ناموفق')).toExist(),
      expect(text('مدل در ۶۰ ثانیه پاسخ نداد')).toExist(),
      expect(role('button', { name: 'تلاش دوباره' })).toExist(),
      expect(role('button', { name: 'حذف' })).toExist(),
    )
  })

  test('the result strip names what was created', () => {
    scene(
      setup(),
      given(model({ phase: 'result', maybeResult: Option.some(resultOf()) })),
      expect(text('۱ کار ساخته شد.')).toExist(),
      expect(role('link', { name: 'خرید نان' })).toExist(),
    )
  })

  test('history shows a capture status and its text', () => {
    scene(
      setup(),
      given(
        model({
          history: [captureOf({ status: 'committed' })],
        }),
      ),
      expect(text('کپچرهای اخیر')).toExist(),
      expect(text('ساخته شد')).toExist(),
      expect(text('خرید نان')).toExist(),
    )
  })
})
