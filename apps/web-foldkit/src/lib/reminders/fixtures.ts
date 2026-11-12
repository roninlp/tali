import type { ReminderDispatch } from './api'

/**
 * Shared ReminderDispatch rows for the ledger's client tests.
 *
 * Both the inbox page fixtures and the plain-HTTP client test answer with the
 * same dispatch shape, so the field set and its default ids live here once.
 * `scheduledFor`/`deliverAt`/`rootScheduledFor` are the same instant because a
 * scheduled dispatch has not drifted or snoozed yet.
 */

export const DISPATCH_ID = '0192f0a0-0000-7000-8000-000000000101'
export const CHILD_DISPATCH_ID = '0192f0a0-0000-7000-8000-000000000103'
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
