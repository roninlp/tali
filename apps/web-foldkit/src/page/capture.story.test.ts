import { Option } from 'effect'
import {
  Command,
  given,
  message,
  model,
  story,
} from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import {
  type Capture,
  type CaptureCommitResult,
  type CaptureDraft,
  CaptureId,
  UserId,
} from '@tali/domain'

import { USER_ID } from '../test-fixtures'
import * as CapturePage from './capture'
import type { Inputs, Model } from './capture'

/**
 * The `/capture` update logic (ticket #101).
 *
 * Pure Story tests: no RPC, no model, no localStorage. They pin the state
 * machine, the Needs Input block, the cache Command and the result handling.
 */

const inputs = (overrides: Partial<Inputs> = {}): Inputs => ({
  display: { timeZone: 'Asia/Tehran', weekStart: 'saturday', digits: 'persian' },
  isOnline: true,
  maybeUserId: Option.some(USER_ID),
  today: '2026-11-09',
  ...overrides,
})

const update = (overrides: Partial<Inputs> = {}) => {
  const values = inputs(overrides)
  return (capture: Model, message: CapturePage.Message) =>
    CapturePage.update(capture, message, values)
}

const initial = (): Model =>
  CapturePage.initialModel({ maybeUserId: Option.some(USER_ID) })

const taskDraft: CaptureDraft = {
  _tag: 'task',
  title: 'خرید نان',
  sourceQuote: 'خرید نان',
  missing: [],
}

/** An event whose day is known but whose clock time the model left open. */
const eventDraft = (
  overrides: Partial<Extract<CaptureDraft, { _tag: 'event' }>> = {},
): CaptureDraft => ({
  _tag: 'event',
  title: 'جلسه',
  sourceQuote: 'سه شنبه ساعت ۴ جلسه با مدیر دارم',
  timing: {
    _tag: 'timed',
    start: '2026-11-10T12:30:00.000Z',
    end: '2026-11-10T13:30:00.000Z',
  },
  timeZone: 'Asia/Tehran',
  missing: [
    {
      field: 'timing.start',
      shape: 'clockTime',
      question: 'ساعت شروع؟',
    },
    { field: 'timing.end', shape: 'clockTime', question: 'ساعت پایان؟' },
  ],
  ...overrides,
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

const cardOf = (draft: CaptureDraft = taskDraft): CapturePage.CaptureCard =>
  CapturePage.CaptureCard.make({
    cardId: `card-${draft._tag}`,
    draft,
    title: draft.title ?? '',
    isDiscarded: false,
  })

const resultOf = (overrides: Partial<CaptureCommitResult> = {}): CaptureCommitResult => ({
  capture: captureOf({ status: 'committed', committedAt: '2026-11-08T09:00:00.000Z' }),
  created: [
    { type: 'task', id: 'task-1', title: 'خرید نان' },
  ],
  failure: null,
  remaining: 0,
  ...overrides,
})

describe('capture composer', () => {
  test('typing caches the text for the signed-in user', () => {
    story(
      update(),
      given(initial()),
      message(CapturePage.Message.UpdatedText({ value: 'فردا دکتر' })),
      model((current) => {
        expect(current.text).toBe('فردا دکتر')
      }),
      Command.expectExact(
        CapturePage.CacheText({ userId: USER_ID, text: 'فردا دکتر' }),
      ),
      Command.resolve(
        CapturePage.CacheText,
        CapturePage.Message.CompletedCacheText(),
      ),
    )
  })

  test('dissecting online starts the Dissect command', () => {
    story(
      update(),
      given({ ...initial(), text: 'فردا دکتر' }),
      message(CapturePage.Message.ClickedDissect()),
      model((current) => {
        expect(current.phase).toBe('dissecting')
      }),
      Command.expectExact(
        CapturePage.DissectCapture({ generation: 1, text: 'فردا دکتر' }),
      ),
      Command.resolve(
        CapturePage.DissectCapture,
        CapturePage.Message.CompletedDissect({ capture: captureOf() }),
      ),
      Command.resolve(
        CapturePage.LoadHistory,
        CapturePage.Message.CompletedLoadHistory({ generation: 1, captures: [] }),
      ),
    )
  })

  test('offline keeps the text and explains the connection requirement', () => {
    story(
      update({ isOnline: false }),
      given({ ...initial(), text: 'فردا دکتر' }),
      message(CapturePage.Message.ClickedDissect()),
      model((current) => {
        expect(current.phase).toBe('idle')
        expect(current.text).toBe('فردا دکتر')
        expect(Option.getOrThrow(current.maybeError)).toContain('اینترنت')
      }),
      Command.expectNone(),
    )
  })

  test('a parsed Dissect becomes review cards', () => {
    story(
      update(),
      given(initial()),
      message(CapturePage.Message.CompletedDissect({ capture: captureOf() })),
      model((current) => {
        expect(current.phase).toBe('review')
        expect(current.cards).toHaveLength(1)
        expect(current.cards[0]?.title).toBe('خرید نان')
      }),
      Command.resolve(
        CapturePage.LoadHistory,
        CapturePage.Message.CompletedLoadHistory({ generation: 1, captures: [] }),
      ),
    )
  })

  test('a failed Dissect stays on the composer with the error', () => {
    story(
      update(),
      given(initial()),
      message(
        CapturePage.Message.CompletedDissect({
          capture: captureOf({
            status: 'failed',
            drafts: [],
            error: 'gateway unavailable',
          }),
        }),
      ),
      model((current) => {
        expect(current.phase).toBe('idle')
        expect(Option.getOrThrow(current.maybeError)).toContain('gateway')
      }),
      Command.expectExact(CapturePage.LoadHistory({ generation: 1 })),
      Command.resolve(
        CapturePage.LoadHistory,
        CapturePage.Message.CompletedLoadHistory({ generation: 1, captures: [] }),
      ),
    )
  })
})

describe('capture review', () => {
  test('discarding a card removes it from the commit set', () => {
    story(
      update(),
      given({ ...initial(), phase: 'review', cards: [cardOf()] }),
      message(CapturePage.Message.ClickedDiscardCard({ index: 0 })),
      model((current) => {
        expect(CapturePage.visibleCards(current)).toHaveLength(0)
      }),
    )
  })

  test('an unanswered Needs Input blocks the commit with an explanation', () => {
    const blocked: CaptureDraft = {
      ...taskDraft,
      missing: [
        { field: 'dueDate', shape: 'localDate', question: 'چه روزی؟' },
      ],
    }
    story(
      update(),
      given({
        ...initial(),
        phase: 'review',
        cards: [cardOf(blocked)],
        maybeCaptureId: Option.some(captureOf().id),
      }),
      message(CapturePage.Message.ClickedCommit()),
      model((current) => {
        expect(current.phase).toBe('review')
        expect(Option.getOrThrow(current.maybeError)).toContain('Needs Input')
      }),
      Command.expectNone(),
    )
  })

  test('answering a Needs Input writes the field and unblocks the card', () => {
    const blocked: CaptureDraft = {
      ...taskDraft,
      missing: [
        { field: 'dueDate', shape: 'localDate', question: 'چه روزی؟' },
      ],
    }
    story(
      update(),
      given({ ...initial(), phase: 'review', cards: [cardOf(blocked)] }),
      message(
        CapturePage.Message.AnsweredNeedsInput({
          index: 0,
          field: 'dueDate',
          value: '2026-11-09',
        }),
      ),
      model((current) => {
        const card = current.cards[0]
        expect(card?.draft._tag).toBe('task')
        if (card?.draft._tag === 'task') {
          expect(card.draft.dueDate).toBe('2026-11-09')
        }
        expect(card?.draft.missing).toEqual([])
      }),
    )
  })

  test('a clock-time Needs Input resolves against the event day and clears', () => {
    story(
      update(),
      given({
        ...initial(),
        phase: 'review',
        cards: [cardOf(eventDraft())],
      }),
      message(
        CapturePage.Message.AnsweredNeedsInput({
          index: 0,
          field: 'timing.start',
          value: '17:00',
        }),
      ),
      model((current) => {
        const card = current.cards[0]
        expect(card?.draft._tag).toBe('event')
        if (card?.draft._tag === 'event') {
          expect(card.draft.timing).toEqual({
            _tag: 'timed',
            start: '2026-11-10T13:30:00Z',
            end: '2026-11-10T13:30:00.000Z',
          })
        }
        // The end question is a separate answer; it must stay open.
        expect(card?.draft.missing.map((entry) => entry.field)).toEqual([
          'timing.end',
        ])
      }),
    )
  })

  test('answering the event end clears only the end entry', () => {
    const draft = eventDraft({
      missing: [
        { field: 'timing.end', shape: 'clockTime', question: 'ساعت پایان؟' },
      ],
    })
    story(
      update(),
      given({ ...initial(), phase: 'review', cards: [cardOf(draft)] }),
      message(
        CapturePage.Message.AnsweredNeedsInput({
          index: 0,
          field: 'timing.end',
          value: '18:30',
        }),
      ),
      model((current) => {
        const card = current.cards[0]
        expect(card?.draft._tag).toBe('event')
        if (card?.draft._tag === 'event') {
          expect(card.draft.timing).toEqual({
            _tag: 'timed',
            start: '2026-11-10T12:30:00.000Z',
            end: '2026-11-10T15:00:00Z',
          })
        }
        expect(card?.draft.missing).toEqual([])
      }),
    )
  })

  test('the structural start picker answers its Needs Input entry', () => {
    story(
      update(),
      given({ ...initial(), phase: 'review', cards: [cardOf(eventDraft())] }),
      message(
        CapturePage.Message.UpdatedCardField({
          index: 0,
          field: 'timing.start',
          value: '2026-11-10T14:00:00.000Z',
        }),
      ),
      model((current) => {
        const card = current.cards[0]
        expect(card?.draft._tag).toBe('event')
        if (card?.draft._tag === 'event') {
          expect(card.draft.timing).toEqual({
            _tag: 'timed',
            start: '2026-11-10T14:00:00.000Z',
            end: '2026-11-10T13:30:00.000Z',
          })
        }
        expect(card?.draft.missing.map((entry) => entry.field)).toEqual([
          'timing.end',
        ])
      }),
    )
  })

  test('a clock time with no known day leaves a blocking Needs Input', () => {
    const draft = eventDraft({ timing: undefined })
    story(
      update(),
      given({ ...initial(), phase: 'review', cards: [cardOf(draft)] }),
      message(
        CapturePage.Message.AnsweredNeedsInput({
          index: 0,
          field: 'timing.start',
          value: '17:00',
        }),
      ),
      model((current) => {
        const card = current.cards[0]
        expect(card?.draft._tag).toBe('event')
        if (card?.draft._tag === 'event') {
          expect(card.draft.timing).toBeUndefined()
        }
        expect(card?.draft.missing.map((entry) => entry.field)).toContain(
          'timing.start',
        )
      }),
    )
  })

  test('retrying a failed history row reloads its text and dissects again', () => {
    const failed = captureOf({
      status: 'failed',
      error: 'مدل در ۶۰ ثانیه پاسخ نداد',
      drafts: [],
    })
    story(
      update(),
      given({ ...initial(), history: [failed] }),
      message(
        CapturePage.Message.ClickedRetryHistory({ captureId: failed.id }),
      ),
      model((current) => {
        expect(current.text).toBe(failed.text)
        expect(current.phase).toBe('dissecting')
        expect(current.expandedHistoryId).toEqual(Option.none())
        expect(current.maybeError).toEqual(Option.none())
      }),
      Command.expectExact(
        CapturePage.CacheText({ userId: USER_ID, text: failed.text }),
        CapturePage.DissectCapture({ generation: 1, text: failed.text }),
      ),
      Command.resolve(
        CapturePage.CacheText,
        CapturePage.Message.CompletedCacheText(),
      ),
      Command.resolve(
        CapturePage.DissectCapture,
        CapturePage.Message.CompletedDissect({ capture: captureOf() }),
      ),
      Command.resolve(
        CapturePage.LoadHistory,
        CapturePage.Message.CompletedLoadHistory({
          generation: 1,
          captures: [captureOf()],
        }),
      ),
    )
  })

  test('retrying offline keeps the text and explains it needs a network', () => {
    const failed = captureOf({ status: 'failed', drafts: [] })
    story(
      update({ isOnline: false }),
      given({ ...initial(), history: [failed] }),
      message(
        CapturePage.Message.ClickedRetryHistory({ captureId: failed.id }),
      ),
      model((current) => {
        expect(current.text).toBe(failed.text)
        expect(current.phase).toBe('idle')
        expect(Option.getOrThrow(current.maybeError)).toContain('اینترنت')
      }),
      Command.expectExact(
        CapturePage.CacheText({ userId: USER_ID, text: failed.text }),
      ),
      Command.resolve(
        CapturePage.CacheText,
        CapturePage.Message.CompletedCacheText(),
      ),
    )
  })

  test('deleting a failed history row drops it from the list', () => {
    const failed = captureOf({ status: 'failed', drafts: [] })
    const kept = captureOf({
      id: CaptureId.make('0192f0a0-0000-7000-8000-000000000011'),
      status: 'committed',
    })
    story(
      update(),
      given({
        ...initial(),
        history: [failed, kept],
        expandedHistoryId: Option.some(failed.id),
      }),
      message(
        CapturePage.Message.ClickedDeleteHistory({ captureId: failed.id }),
      ),
      Command.expectExact(CapturePage.DeleteCapture({ captureId: failed.id })),
      Command.resolve(
        CapturePage.DeleteCapture,
        CapturePage.Message.CompletedDeleteHistory({ capture: failed }),
      ),
      model((current) => {
        expect(current.history.map((row) => row.id)).toEqual([kept.id])
        expect(current.expandedHistoryId).toEqual(Option.none())
      }),
    )
  })

  test('a failed delete surfaces the history error', () => {
    const failed = captureOf({ status: 'failed', drafts: [] })
    story(
      update(),
      given({ ...initial(), history: [failed] }),
      message(
        CapturePage.Message.ClickedDeleteHistory({ captureId: failed.id }),
      ),
      Command.expectExact(CapturePage.DeleteCapture({ captureId: failed.id })),
      Command.resolve(
        CapturePage.DeleteCapture,
        CapturePage.Message.FailedDeleteHistory({
          failure: {
            code: 'Network',
            message: 'ارتباط با سرور برقرار نشد.',
          },
        }),
      ),
      model((current) => {
        expect(current.history.map((row) => row.id)).toEqual([failed.id])
        expect(Option.getOrThrow(current.maybeHistoryError)).toContain(
          'ارتباط',
        )
      }),
    )
  })

  test('committing sends the reviewed drafts with the capture id', () => {
    story(
      update(),
      given({
        ...initial(),
        phase: 'review',
        cards: [cardOf()],
        maybeCaptureId: Option.some(captureOf().id),
      }),
      message(CapturePage.Message.ClickedCommit()),
      model((current) => {
        expect(current.phase).toBe('committing')
      }),
      Command.expectExact(
        CapturePage.CommitCapture({
          generation: 1,
          captureId: captureOf().id,
          drafts: [taskDraft],
        }),
      ),
      Command.resolve(
        CapturePage.CommitCapture,
        CapturePage.Message.CompletedCommit({ result: resultOf() }),
      ),
      Command.resolve(
        CapturePage.CacheText,
        CapturePage.Message.CompletedCacheText(),
      ),
      Command.resolve(
        CapturePage.LoadHistory,
        CapturePage.Message.CompletedLoadHistory({ generation: 1, captures: [] }),
      ),
    )
  })

  test('a complete commit clears the composer and shows the result', () => {
    story(
      update(),
      given({
        ...initial(),
        phase: 'committing',
        text: 'خرید نان',
        cards: [cardOf()],
        maybeCaptureId: Option.some(captureOf().id),
      }),
      message(CapturePage.Message.CompletedCommit({ result: resultOf() })),
      model((current) => {
        expect(current.phase).toBe('result')
        expect(current.text).toBe('')
        expect(Option.isSome(current.maybeResult)).toBe(true)
      }),
      Command.expectExact(
        CapturePage.CacheText({ userId: USER_ID, text: '' }),
        CapturePage.LoadHistory({ generation: 1 }),
      ),
      Command.resolve(
        CapturePage.CacheText,
        CapturePage.Message.CompletedCacheText(),
      ),
      Command.resolve(
        CapturePage.LoadHistory,
        CapturePage.Message.CompletedLoadHistory({ generation: 1, captures: [] }),
      ),
    )
  })

  test('a partial commit keeps the text and offers a retry', () => {
    story(
      update(),
      given({
        ...initial(),
        phase: 'committing',
        text: 'خرید نان',
        cards: [cardOf()],
        maybeCaptureId: Option.some(captureOf().id),
      }),
      message(
        CapturePage.Message.CompletedCommit({
          result: resultOf({
            failure: { draftIndex: 0, error: 'TaskValidationError' },
            remaining: 1,
            created: [],
          }),
        }),
      ),
      model((current) => {
        expect(current.phase).toBe('result')
        expect(current.text).toBe('خرید نان')
        expect(Option.getOrThrow(current.maybeError)).toContain('بخشی')
      }),
      Command.resolve(
        CapturePage.LoadHistory,
        CapturePage.Message.CompletedLoadHistory({ generation: 1, captures: [] }),
      ),
    )
  })

  test('a new capture clears the cards and the result', () => {
    story(
      update(),
      given({
        ...initial(),
        phase: 'result',
        cards: [cardOf()],
        maybeResult: Option.some(resultOf()),
        maybeCaptureId: Option.some(captureOf().id),
      }),
      message(CapturePage.Message.ClickedNewCapture()),
      model((current) => {
        expect(current.phase).toBe('idle')
        expect(current.cards).toEqual([])
        expect(Option.isNone(current.maybeResult)).toBe(true)
      }),
      Command.expectExact(CapturePage.CacheText({ userId: USER_ID, text: '' })),
      Command.resolve(
        CapturePage.CacheText,
        CapturePage.Message.CompletedCacheText(),
      ),
    )
  })
})
