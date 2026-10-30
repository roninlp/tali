import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { ReminderInboxItem } from '../lib/reminders/api'
import { buttonView } from '../ui/button'
import { Message } from './reminders'
import type { Model } from './reminders'
import {
  SNOOZE_CHOICES,
  criticalBadge,
  formatReminderInstant,
  formatRespondedAt,
  optionalNote,
  reminderKindLabel,
  responseCopy,
} from './reminders-model'

/**
 * `/reminders` inbox panel, ported from
 * `apps/web/src/components/reminder-inbox.tsx` (ticket #61; FR-REM-02/03).
 *
 * The panel is the ledger's recovery path: every item carries its scheduled
 * time, kind, medication badge and note, and an unanswered row keeps the same
 * Done/Snooze/Dismiss actions as the notification. The history toggle swaps the
 * heading, empty copy and each row's action block for the recorded answer.
 */

const headingText = (model: Model): string =>
  model.isHistory ? 'تاریخچه‌ی یادآوری‌ها' : 'یادآورهای ازدست‌رفته'

const toggleText = (model: Model): string =>
  model.isHistory ? 'بازگشت به صندوق' : 'تاریخچه'

const emptyText = (model: Model): string =>
  model.isHistory
    ? 'هنوز یادآوری پاسخ‌داده‌شده‌ای ثبت نشده است.'
    : 'یادآوری بی‌پاسخی نیست. هر یادآوری که مرورگر آن را ندیده باشد اینجا می‌آید، نه اینکه ناپدید شود.'

const loadingView = (h: HtmlBuilder<Message>): Html =>
  h.p(
    [h.Class('m-0 flex items-center gap-2 text-sm text-base-content/55')],
    [
      h.span([h.Class('loading loading-spinner loading-sm')]),
      'در حال خواندن دفتر ارسال…',
    ],
  )

const emptyView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.p(
    [h.Class('m-0 text-sm leading-8 text-base-content/55')],
    [emptyText(model)],
  )

const statusView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const isEmpty = Array.isReadonlyArrayEmpty(model.items)

  if (model.isLoading && isEmpty) {
    return loadingView(h)
  }

  return !model.isLoading && isEmpty ? emptyView(model, h) : h.empty
}

const errorView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeError, {
    onNone: () => h.empty,
    onSome: message =>
      h.p(
        [
          h.Role('alert'),
          h.Class('alert alert-error m-0 py-2 text-sm leading-7'),
        ],
        [message],
      ),
  })

const metadataView = (
  item: ReminderInboxItem,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeBadge = criticalBadge(item.tier)
  const maybeNote = optionalNote(item.note)

  return h.div(
    [h.Class('flex flex-wrap items-center gap-1.5')],
    [
      h.span(
        [h.Class('badge badge-ghost badge-sm')],
        [reminderKindLabel(item.kind)],
      ),
      Option.match(maybeBadge, {
        onNone: () => h.empty,
        onSome: badge =>
          h.span([h.Class('badge badge-error badge-sm')], [badge]),
      }),
      Option.match(maybeNote, {
        onNone: () => h.empty,
        onSome: note =>
          h.span([h.Class('text-[0.8rem] text-base-content/55')], [note]),
      }),
    ],
  )
}

const snoozeSelectView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.select(
    [
      h.AriaLabel('مدت به تعویق انداختن'),
      h.Value(String(model.snoozeMinutes)),
      h.Class('select select-bordered select-sm w-auto'),
      h.OnChange(value =>
        Message.ChangedSnoozeMinutes({ minutes: Number(value) }),
      ),
    ],
    Array.map(SNOOZE_CHOICES, minutes =>
      h.option([h.Value(String(minutes))], [`${minutes} دقیقه`]),
    ),
  )

const inboxActionsView = (
  model: Model,
  item: ReminderInboxItem,
  h: HtmlBuilder<Message>,
): Html => {
  const isBusy = Option.isSome(model.maybeBusyDispatchId)
  const dispatchId = item.dispatch.id

  return h.div(
    [h.Class('flex flex-wrap items-center gap-1.5')],
    [
      buttonView(
        {
          type: 'button',
          size: 'sm',
          isDisabled: isBusy,
          children: ['انجام شد'],
          onClick: Message.ClickedRespond({
            dispatchId,
            response: 'done',
          }),
        },
        h,
      ),
      snoozeSelectView(model, h),
      buttonView(
        {
          type: 'button',
          variant: 'ghost',
          size: 'sm',
          isDisabled: isBusy,
          children: ['بعداً'],
          onClick: Message.ClickedRespond({
            dispatchId,
            response: 'snooze',
          }),
        },
        h,
      ),
      buttonView(
        {
          type: 'button',
          variant: 'ghost',
          size: 'sm',
          isDisabled: isBusy,
          children: ['کنار گذاشتن'],
          onClick: Message.ClickedRespond({
            dispatchId,
            response: 'dismiss',
          }),
        },
        h,
      ),
    ],
  )
}

const answeredView = (item: ReminderInboxItem, h: HtmlBuilder<Message>): Html =>
  h.p(
    [h.Class('m-0 text-[0.78rem] text-base-content/50')],
    [
      `${responseCopy(item.dispatch.response)} · ${formatRespondedAt(item.dispatch.respondedAt)}`,
    ],
  )

const rowView = (
  model: Model,
  item: ReminderInboxItem,
  h: HtmlBuilder<Message>,
): Html => {
  const isCritical = item.tier === 'critical'

  return h.keyed('li')(
    item.dispatch.id,
    [
      h.Class(
        isCritical
          ? 'grid gap-1.5 rounded-box border border-error/30 bg-error/5 p-3'
          : 'grid gap-1.5 rounded-box border border-base-300 bg-base-200/40 p-3',
      ),
    ],
    [
      h.div(
        [h.Class('flex flex-wrap items-baseline justify-between gap-2')],
        [
          h.strong([h.Class('text-[0.95rem]')], [item.title]),
          h.span(
            [h.Class('text-[0.78rem] text-base-content/50')],
            [formatReminderInstant(item.dispatch.scheduledFor)],
          ),
        ],
      ),
      metadataView(item, h),
      item.state === 'inbox'
        ? inboxActionsView(model, item, h)
        : answeredView(item, h),
    ],
  )
}

export const remindersPageView = (
  model: Model,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.AriaLabelledBy('reminder-inbox-heading'),
      h.Class('panel grid gap-4 p-4 sm:p-5'),
    ],
    [
      h.div(
        [h.Class('flex flex-wrap items-center justify-between gap-2')],
        [
          h.h2(
            [h.Id('reminder-inbox-heading'), h.Class('m-0 text-lg font-bold')],
            [headingText(model)],
          ),
          buttonView(
            {
              type: 'button',
              variant: 'ghost',
              children: [toggleText(model)],
              onClick: Message.ClickedToggleHistory(),
            },
            h,
          ),
        ],
      ),
      errorView(model, h),
      statusView(model, h),
      h.ul(
        [h.Class('m-0 grid list-none gap-2 p-0')],
        Array.map(model.items, item => rowView(model, item, h)),
      ),
      h.p(
        [h.Class('m-0 text-[0.78rem] leading-7 text-base-content/45')],
        [
          'این فهرست از دفتر ارسال سرور خوانده می‌شود؛ اگر مرورگر بسته باشد یا اعلان نرسد، یادآوری پس از ۲۴ ساعت به تاریخچه می‌رود و هرگز حذف نمی‌شود.',
        ],
      ),
    ],
  )
