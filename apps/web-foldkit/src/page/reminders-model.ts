import { Option } from 'effect'

import {
  DEFAULT_NOTIFICATION_SNOOZE_MINUTES,
  REMINDER_KIND_LABELS,
  SNOOZE_PRESETS_MINUTES,
  isSnoozeMinutes,
} from '@tali/domain'

import type {
  DispatchResponse,
  ReminderFailure,
  ReminderKind,
  ReminderTier,
} from '../lib/reminders/api'

/**
 * Pure copy and formatting for the missed-reminder inbox, ported from
 * `apps/web/src/components/reminder-inbox.tsx` (ticket #61; FR-REM-02/03).
 */

export const SNOOZE_CHOICES: ReadonlyArray<number> = SNOOZE_PRESETS_MINUTES

export const DEFAULT_SNOOZE_MINUTES = DEFAULT_NOTIFICATION_SNOOZE_MINUTES

export const reminderKindLabel = (kind: ReminderKind): string =>
  REMINDER_KIND_LABELS[kind]

/** The critical-tier badge; medication is the only critical tier in the MVP. */
export const criticalBadge = (tier: ReminderTier): Option.Option<string> =>
  tier === 'critical' ? Option.some('دارو') : Option.none()

/** The note is shown only when it carries text. */
export const optionalNote = (note: string | null): Option.Option<string> =>
  Option.filter(Option.fromNullishOr(note), value => value !== '')

export const formatReminderInstant = (iso: string): string => {
  const value = Date.parse(iso)

  if (Number.isNaN(value)) {
    return ''
  }

  return new Intl.DateTimeFormat('fa-IR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(value)
}

export const formatRespondedAt = (iso: string | null): string =>
  iso === null ? '' : formatReminderInstant(iso)

/** The ledger's recorded answer, in the inbox's words. */
export const responseCopy = (response: DispatchResponse | null): string => {
  if (response === 'done') {
    return 'انجام شد'
  }

  if (response === 'snooze') {
    return 'به بعد موکول شد'
  }

  return 'کنار گذاشته شد'
}

export const reminderFailureCopy = (failure: ReminderFailure): string => {
  if (failure.code === 'Unauthorized') {
    return 'برای پاسخ به یادآوری باید وارد شوید.'
  }

  if (failure.code === 'Network') {
    return 'ارتباط با سرور برقرار نشد؛ پاسخ پس از اتصال دوباره فرستاده می‌شود.'
  }

  if (failure.code === 'NotFound') {
    return 'این یادآوری دیگر در دفتر ارسال نیست.'
  }

  return 'ثبت پاسخ ناموفق بود؛ دوباره تلاش کنید.'
}

export const isSnoozePreset = (minutes: number): boolean =>
  isSnoozeMinutes(minutes)
