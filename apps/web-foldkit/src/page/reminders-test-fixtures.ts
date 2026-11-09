import { noReminderLink } from '@tali/domain'

import type { ReminderDispatch, ReminderInboxItem } from '../lib/reminders/api'
import * as Reminders from './reminders'

export const DISPATCH_ID = '0192f0a0-0000-7000-8000-000000000101'
export const SECOND_DISPATCH_ID = '0192f0a0-0000-7000-8000-000000000104'
export const THIRD_DISPATCH_ID = '0192f0a0-0000-7000-8000-000000000105'
export const FOURTH_DISPATCH_ID = '0192f0a0-0000-7000-8000-000000000106'
export const FIFTH_DISPATCH_ID = '0192f0a0-0000-7000-8000-000000000107'
export const REMINDER_ID = '0192f0a0-0000-7000-8000-000000000102'

export const dispatchRow = (
  overrides: Partial<ReminderDispatch> = {},
): ReminderDispatch => ({
  id: DISPATCH_ID,
  reminderId: REMINDER_ID,
  userId: '0192f0a0-0000-7000-8000-000000000001',
  scheduledFor: '2026-10-20T08:00:00.000Z',
  deliverAt: '2026-10-20T08:00:00.000Z',
  rootScheduledFor: '2026-10-20T08:00:00.000Z',
  origin: 'schedule',
  pushOutcome: 'accepted',
  attempts: 1,
  lastAttemptAt: '2026-10-20T08:00:05.000Z',
  parentDispatchId: null,
  response: null,
  respondedAt: null,
  snoozedUntil: null,
  createdAt: '2026-10-20T08:00:00.000Z',
  ...overrides,
})

export const inboxItem = (
  overrides: Partial<ReminderInboxItem> = {},
): ReminderInboxItem => ({
  dispatch: dispatchRow(),
  reminderId: REMINDER_ID,
  title: 'داروی فشار',
  note: 'یک قرص همراه با غذا',
  kind: 'medication',
  tier: 'critical',
  link: noReminderLink(),
  visibility: 'private',
  state: 'inbox',
  ...overrides,
})

export const medicationItem = (): ReminderInboxItem => inboxItem()

export const choreItem = (): ReminderInboxItem =>
  inboxItem({
    dispatch: dispatchRow({
      id: SECOND_DISPATCH_ID,
      scheduledFor: '2026-10-20T09:00:00.000Z',
      deliverAt: '2026-10-20T09:00:00.000Z',
      rootScheduledFor: '2026-10-20T09:00:00.000Z',
    }),
    title: 'آب دادن گلدان‌ها',
    note: null,
    kind: 'chore',
    tier: 'normal',
  })

export const answeredDoneItem = (): ReminderInboxItem =>
  inboxItem({
    dispatch: dispatchRow({
      id: THIRD_DISPATCH_ID,
      response: 'done',
      respondedAt: '2026-10-20T08:10:00.000Z',
    }),
    state: 'history',
  })

export const answeredSnoozeItem = (): ReminderInboxItem =>
  inboxItem({
    dispatch: dispatchRow({
      id: FOURTH_DISPATCH_ID,
      response: 'snooze',
      respondedAt: '2026-10-20T08:12:00.000Z',
      snoozedUntil: '2026-10-20T08:22:00.000Z',
    }),
    title: 'ورزش صبحگاهی',
    note: null,
    kind: 'exercise',
    tier: 'normal',
    state: 'history',
  })

export const dismissedItem = (): ReminderInboxItem =>
  inboxItem({
    dispatch: dispatchRow({
      id: FIFTH_DISPATCH_ID,
      response: 'dismiss',
      respondedAt: '2026-10-20T08:14:00.000Z',
    }),
    title: 'تماس با مادر',
    note: null,
    kind: 'general',
    tier: 'normal',
    state: 'history',
  })

export const remindersModel = (
  overrides: Partial<Reminders.Model> = {},
): Reminders.Model => ({ ...Reminders.initialModel(), ...overrides })
