import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Listbox } from '@foldkit/ui'

import type { ReminderInboxItem } from '../lib/reminders/api'
import { shareActionOf } from '../lib/visibility-writes'
import { buttonView } from '../ui/button'
import { emptyStateView, inlineAlertView } from '../ui/feedback'
import { listboxViewInputs } from '../ui/listbox'
import { Message, SnoozeListbox, snoozeListboxFor } from './reminders'
import type { Model, SnoozeOption } from './reminders'
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
    [
      h.Class(
        'm-0 flex items-center gap-2 text-sm leading-7 text-base-content/70',
      ),
    ],
    [h.span([h.Class('spinner spinner-sm')]), 'در حال خواندن دفتر ارسال…'],
  )

const emptyView = (model: Model, h: HtmlBuilder<Message>): Html =>
  emptyStateView(emptyText(model), h)

const statusView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const isEmpty = Array.isReadonlyArrayEmpty(model.items)

  if (model.isLoading && isEmpty) {
    return loadingView(h)
  }

  return !model.isLoading && isEmpty ? emptyView(model, h) : h.empty
}

const errorView = (model: Model, h: HtmlBuilder<Message>): Html =>
  inlineAlertView(model.maybeError, h)

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
          h.span(
            [h.Class('text-[0.78rem] leading-6 text-base-content/70')],
            [note],
          ),
      }),
    ],
  )
}

const SNOOZE_OPTIONS: ReadonlyArray<SnoozeOption> = Array.map(
  SNOOZE_CHOICES,
  minutes => ({ value: String(minutes), label: `${minutes} دقیقه` }),
)

const snoozeSelectView = (
  model: Model,
  item: ReminderInboxItem,
  h: HtmlBuilder<Message>,
): Html => {
  const dispatchId = item.dispatch.id
  const listbox = snoozeListboxFor(model, dispatchId)

  return h.div(
    [h.Class('grid gap-1.5')],
    [
      h.label(
        [h.For(Listbox.buttonId(listbox.id)), h.Class('sr-only')],
        ['مدت به تعویق انداختن'],
      ),
      h.submodel({
        slotId: listbox.id,
        model: listbox,
        view: SnoozeListbox.view,
        viewInputs: listboxViewInputs({
          items: SNOOZE_OPTIONS,
          maybeSelectedValue: Option.some(String(model.snoozeMinutes)),
          h,
        }),
        toParentMessage: message =>
          Message.GotSnoozeListboxMessage({ dispatchId, message }),
      }),
    ],
  )
}

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
          variant: 'ghost',
          size: 'sm',
          isDisabled: isBusy,
          children: [shareActionOf(item.visibility).label],
          onClick: Message.ClickedToggleReminderVisibility({
            reminderId: item.reminderId,
            visibility: item.visibility === 'shared' ? 'private' : 'shared',
          }),
        },
        h,
      ),
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
      snoozeSelectView(model, item, h),
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
    [h.Class('m-0 text-[0.72rem] leading-6 text-base-content/70')],
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
          ? 'grid gap-1.5 border-s-2 border-s-error/50 bg-error/5 py-3 ps-3'
          : 'grid gap-1.5 border-s-2 border-s-transparent py-3 ps-3',
      ),
    ],
    [
      h.div(
        [h.Class('flex flex-wrap items-baseline justify-between gap-2')],
        [
          h.strong(
            [h.Class('text-[0.95rem] leading-6 font-semibold break-words')],
            [item.title],
          ),
          h.span(
            [h.Class('text-[0.72rem] leading-6 text-base-content/70')],
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
      h.Class('panel grid grid-cols-1 gap-4 p-4 sm:p-5'),
    ],
    [
      h.div(
        [h.Class('flex flex-wrap items-center justify-between gap-2')],
        [
          h.h2(
            [
              h.Id('reminder-inbox-heading'),
              h.Class('m-0 text-[0.95rem] font-semibold'),
            ],
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
        [h.Class('m-0 grid list-none divide-y divide-base-300 p-0')],
        Array.map(model.items, item => rowView(model, item, h)),
      ),
      h.p(
        [h.Class('m-0 text-[0.72rem] leading-6 text-base-content/70')],
        [
          'این فهرست از دفتر ارسال سرور خوانده می‌شود؛ اگر مرورگر بسته باشد یا اعلان نرسد، یادآوری پس از ۲۴ ساعت به تاریخچه می‌رود و هرگز حذف نمی‌شود.',
        ],
      ),
    ],
  )
