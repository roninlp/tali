import { For, Show, createMemo, createSignal, onSettled } from "solid-js"
import {
  localizeDigits,
  type Digits,
  type EventEditScope,
  type EventOccurrence
} from "@tali/domain"
import {
  occurrenceDurationMinutes,
  occurrenceStartMinutes,
  occurrenceTimeLabel,
  wallTimeIn
} from "../../lib/events/model"

/** The zone the grid/labels read: the viewer's, like the rest of the week. */

/**
 * The calendar's event lane UI (ticket #62; FR-CAL-01/03).
 *
 * Three pieces:
 *
 * - `EventQuickAdd` — a day cell's "add an event" disclosure. All-day by
 *   default (a date is what the cell knows), with a time range for a timed
 *   event; the write itself is the screen's local-first mirror write.
 * - `EventEditor` — the title/time editor opened from an occurrence. It is a
 *   plain form; the scope question is asked separately.
 * - `EventScopePrompt` — the "this event" vs "this and following" choice #58's
 *   split semantics needs. It is a real radio group with two explained options
 *   (not a raw flag), labelled for assistive technology, dismissible with
 *   Escape, with the first option focused on open.
 */

export interface EventDraftFields {
  readonly title: string
  readonly date: string
  readonly allDay: boolean
  readonly startTime: string
  readonly endTime: string
}



// ── Quick add ────────────────────────────────────────────────────────────

export interface EventQuickAddProps {
  /** The day the cell was clicked from (`YYYY-MM-DD`). */
  readonly date: string
  readonly label: string
  readonly digits: Digits
  readonly disabled: boolean
  readonly busy: boolean
  readonly onSubmit: (draft: EventDraftFields) => void
}

const timeOf = (instant: string, timeZone: string): string => {
  const parts = wallTimeIn(instant, timeZone)
  return parts === null ? "09:00" : `${pad(parts.hour)}:${pad(parts.minute)}`
}

const pad = (value: number): string => String(value).padStart(2, "0")

export function EventQuickAdd(props: EventQuickAddProps) {
  const [open, setOpen] = createSignal(false)
  const [title, setTitle] = createSignal("")
  const [allDay, setAllDay] = createSignal(true)
  const [startTime, setStartTime] = createSignal("09:00")
  const [endTime, setEndTime] = createSignal("10:00")

  const reset = () => {
    setTitle("")
    setAllDay(true)
    setStartTime("09:00")
    setEndTime("10:00")
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (props.disabled || props.busy || title().trim() === "") return
    props.onSubmit({
      title: title().trim(),
      date: props.date,
      allDay: allDay(),
      startTime: startTime(),
      endTime: endTime()
    })
    reset()
    setOpen(false)
  }

  return (
    <details
      class="calendar-event-add"
      open={open()}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label={`رویداد تازه برای ${props.label}`}>+ رویداد</summary>
      <form class="calendar-event-form" onSubmit={submit}>
        <input
          aria-label={`عنوان رویداد برای ${props.label}`}
          placeholder="رویداد تازه…"
          value={title()}
          onInput={(event) => setTitle(event.currentTarget.value)}
          disabled={props.disabled}
        />
        <label class="calendar-event-check">
          <input
            type="checkbox"
            checked={allDay()}
            aria-label="تمام روز"
            onChange={(event) => setAllDay(event.currentTarget.checked)}
          />
          تمام روز
        </label>
        <Show when={!allDay()} fallback={<p class="calendar-event-hint">بدون ساعت</p>}>
          <span class="calendar-event-times">
            <label>
              از
              <input
                type="time"
                aria-label={`ساعت شروع رویداد در ${props.label}`}
                value={startTime()}
                onInput={(event) => setStartTime(event.currentTarget.value)}
              />
            </label>
            <label>
              تا
              <input
                type="time"
                aria-label={`ساعت پایان رویداد در ${props.label}`}
                value={endTime()}
                onInput={(event) => setEndTime(event.currentTarget.value)}
              />
            </label>
          </span>
        </Show>
        <button
          type="submit"
          disabled={props.disabled || props.busy || title().trim() === ""}
        >
          {props.busy ? "در حال ذخیره…" : "افزودن رویداد"}
        </button>
      </form>
    </details>
  )
}

// ── Editor ───────────────────────────────────────────────────────────────

export interface EventEditorProps {
  readonly occurrence: EventOccurrence
  readonly digits: Digits
  /** False when the mirrored series row is not readable; saving is refused. */
  readonly canEdit: boolean
  readonly busy: boolean
  readonly error: string | undefined
  readonly onSave: (draft: EventDraftFields) => void
  readonly onDelete: () => void
  readonly onClose: () => void
}

const dateOfAllDay = (occurrence: EventOccurrence): string =>
  occurrence.timing._tag === "allDay" ? occurrence.timing.date : ""

const startDateOfTimed = (occurrence: EventOccurrence): string => {
  if (occurrence.timing._tag !== "timed") return ""
  const parts = wallDateIn(occurrence.timing.start, occurrence.timeZone)
  return parts ?? ""
}

const wallDateIn = (instant: string, timeZone: string): string | null => {
  const millis = Date.parse(instant)
  if (!Number.isFinite(millis)) return null
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(millis))
  } catch {
    return null
  }
}

export function EventEditor(props: EventEditorProps) {
  // The dialog is remounted per occurrence, so the occurrence it opens with is
  // the form's initial (static) snapshot; later prop changes are edits, not a
  // second occurrence.
  // oxlint-disable-next-line solid/reactivity
  const initial = props.occurrence
  const [title, setTitle] = createSignal(initial.title)
  const [allDay, setAllDay] = createSignal(initial.timing._tag === "allDay")
  const [date, setDate] = createSignal(
    initial.timing._tag === "allDay" ? dateOfAllDay(initial) : startDateOfTimed(initial)
  )
  const [startTime, setStartTime] = createSignal(
    initial.timing._tag === "timed" ? timeOf(initial.timing.start, initial.timeZone) : "09:00"
  )
  const [endTime, setEndTime] = createSignal(
    initial.timing._tag === "timed" ? timeOf(initial.timing.end, initial.timeZone) : "10:00"
  )

  let heading: HTMLHeadingElement | undefined
  onSettled(() => heading?.focus())

  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      props.onClose()
    }
  }
  onSettled(() => {
    document.addEventListener("keydown", closeOnEscape)
    return () => document.removeEventListener("keydown", closeOnEscape)
  })

  const save = (event: SubmitEvent) => {
    event.preventDefault()
    if (!props.canEdit || props.busy || title().trim() === "" || date() === "") return
    props.onSave({
      title: title().trim(),
      date: date(),
      allDay: allDay(),
      startTime: startTime(),
      endTime: endTime()
    })
  }

  return (
    <div class="calendar-dialog-backdrop">
      <section
        class="calendar-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-event-editor-title"
      >
        <h2
          id="calendar-event-editor-title"
          ref={(element) => (heading = element)}
          tabindex="-1"
        >
          رویداد
        </h2>
        <p class="calendar-dialog-hint">
          {props.occurrence.recurring
            ? "این رویداد بخشی از یک مجموعهٔ تکرارشونده است."
            : "رویداد تک‌باره."}
        </p>

        <form class="calendar-event-form" onSubmit={save}>
          <label class="calendar-field">
            عنوان
            <input
              aria-label="عنوان رویداد"
              value={title()}
              onInput={(event) => setTitle(event.currentTarget.value)}
              disabled={!props.canEdit || props.busy}
            />
          </label>
          <label class="calendar-event-check">
            <input
              type="checkbox"
              checked={allDay()}
              aria-label="تمام روز"
              disabled={!props.canEdit || props.busy}
              onChange={(event) => setAllDay(event.currentTarget.checked)}
            />
            تمام روز
          </label>
          <label class="calendar-field">
            تاریخ
            <input
              type="date"
              aria-label="تاریخ رویداد"
              value={date()}
              onInput={(event) => setDate(event.currentTarget.value)}
              disabled={!props.canEdit || props.busy}
            />
          </label>
          <Show when={!allDay()}>
            <span class="calendar-event-times">
              <label>
                از
                <input
                  type="time"
                  aria-label="ساعت شروع"
                  value={startTime()}
                  onInput={(event) => setStartTime(event.currentTarget.value)}
                  disabled={!props.canEdit || props.busy}
                />
              </label>
              <label>
                تا
                <input
                  type="time"
                  aria-label="ساعت پایان"
                  value={endTime()}
                  onInput={(event) => setEndTime(event.currentTarget.value)}
                  disabled={!props.canEdit || props.busy}
                />
              </label>
            </span>
          </Show>

          <Show when={!props.canEdit}>
            <p class="calendar-event-hint" role="status">
              این رویداد هنوز در حافظهٔ محلی نیست؛ کمی بعد دوباره تلاش کنید.
            </p>
          </Show>
          <Show when={props.error}>
            <p class="calendar-alert" role="alert">
              {props.error}
            </p>
          </Show>

          <div class="calendar-dialog-actions">
            <button
              type="submit"
              class="calendar-primary"
              disabled={!props.canEdit || props.busy || title().trim() === "" || date() === ""}
            >
              ذخیره
            </button>
            <button
              type="button"
              class="calendar-danger"
              disabled={!props.canEdit || props.busy}
              onClick={() => props.onDelete()}
            >
              حذف رویداد
            </button>
            <button type="button" class="calendar-nav-button" onClick={() => props.onClose()}>
              بستن
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}

// ── Scope prompt ─────────────────────────────────────────────────────────

export interface EventScopePromptProps {
  readonly action: "edit" | "delete"
  /** The occurrence's (possibly edited) title. */
  readonly title: string
  readonly scope: EventEditScope
  readonly busy: boolean
  readonly onScopeChange: (scope: EventEditScope) => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function EventScopePrompt(props: EventScopePromptProps) {
  let selected: HTMLInputElement | undefined
  onSettled(() => selected?.focus())

  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    props.onCancel()
  }
  onSettled(() => {
    document.addEventListener("keydown", closeOnEscape)
    return () => document.removeEventListener("keydown", closeOnEscape)
  })

  const heading = () =>
    props.action === "delete" ? "این رویداد یا کل مجموعه؟" : "ویرایش این رویداد یا مجموعه؟"

  return (
    <div class="calendar-dialog-backdrop">
      <section
        class="calendar-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-scope-title"
        aria-describedby="calendar-scope-body"
      >
        <h2 id="calendar-scope-title" tabindex="-1">
          {heading()}
        </h2>
        <p id="calendar-scope-body" class="calendar-dialog-hint">
          «{props.title}» بخشی از یک مجموعهٔ تکرارشونده است. تغییر را روی کدام بخش
          اعمال کنم؟
        </p>

        <div class="calendar-scope-options" role="radiogroup" aria-labelledby="calendar-scope-title">
          <label class="calendar-scope-option" data-selected={props.scope === "thisOccurrence" ? "true" : undefined}>
            <input
              ref={(element) => {
                if (props.scope === "thisOccurrence") selected = element
              }}
              type="radio"
              name="calendar-event-scope"
              value="thisOccurrence"
              checked={props.scope === "thisOccurrence"}
              onChange={() => props.onScopeChange("thisOccurrence")}
            />
            <span>
              <strong>فقط این رویداد</strong>
              <small>
                تازه‌ترین تغییر فقط روی همین روز اعمال می‌شود؛ بقیهٔ رویدادهای این
                مجموعه همان‌طور که هست می‌ماند.
              </small>
            </span>
          </label>
          <label class="calendar-scope-option" data-selected={props.scope === "thisAndFollowing" ? "true" : undefined}>
            <input
              type="radio"
              name="calendar-event-scope"
              value="thisAndFollowing"
              checked={props.scope === "thisAndFollowing"}
              onChange={() => props.onScopeChange("thisAndFollowing")}
            />
            <span>
              <strong>این رویداد و رویدادهای بعدی</strong>
              <small>
                مجموعه از همین روز به بعد جدا می‌شود؛ روزهای پیش از آن دست‌نخورده
                می‌مانند.
              </small>
            </span>
          </label>
        </div>

        <div class="calendar-dialog-actions">
          <button type="button" class="calendar-primary" disabled={props.busy} onClick={() => props.onConfirm()}>
            {props.busy ? "در حال اعمال…" : "ادامه"}
          </button>
          <button type="button" class="calendar-nav-button" onClick={() => props.onCancel()}>
            انصراف
          </button>
        </div>
      </section>
    </div>
  )
}

// ── Lanes ────────────────────────────────────────────────────────────────

export interface EventRowProps {
  readonly occurrence: EventOccurrence
  readonly digits: Digits
  /** The viewer's zone: the grid reads every event's wall clock in it. */
  readonly timeZone: string
  readonly onOpen: (occurrence: EventOccurrence) => void
}

/** One event in a day list (the drill-down and the week's compact lane). */
export function EventRow(props: EventRowProps) {
  const time = createMemo(() =>
    occurrenceTimeLabel(props.occurrence, props.timeZone, props.digits)
  )
  return (
    <li class="calendar-event-row" data-allday={props.occurrence.timing._tag === "allDay" ? "true" : undefined}>
      <button
        type="button"
        class="calendar-event-open"
        aria-label={`بازکردن ${props.occurrence.title}`}
        onClick={() => props.onOpen(props.occurrence)}
      >
        <span class="calendar-event-time">{time() ?? "تمام روز"}</span>
        <span class="calendar-event-title">{props.occurrence.title}</span>
        <Show when={props.occurrence.projected}>
          <span class="calendar-task-badge">از مجموعه</span>
        </Show>
      </button>
    </li>
  )
}

/** A chip in a day cell (month grid and the week's all-day strip). */
export function EventChip(props: {
  readonly occurrence: EventOccurrence
  readonly digits: Digits
  readonly timeZone: string
  readonly onOpen: (occurrence: EventOccurrence) => void
}) {
  const time = createMemo(() =>
    occurrenceTimeLabel(props.occurrence, props.timeZone, props.digits)
  )
  return (
    <button
      type="button"
      class="calendar-event-chip"
      data-allday={props.occurrence.timing._tag === "allDay" ? "true" : undefined}
      title={`${time() === null ? "تمام روز" : time()} — ${props.occurrence.title}`}
      onClick={() => props.onOpen(props.occurrence)}
    >
      <Show when={time()}>
        {(label) => <span class="calendar-event-chip-time">{label()}</span>}
      </Show>
      <span class="calendar-event-chip-title">{props.occurrence.title}</span>
    </button>
  )
}

// ── Time grid ────────────────────────────────────────────────────────────

export interface TimeGridProps {
  readonly occurrences: ReadonlyArray<EventOccurrence>
  readonly digits: Digits
  readonly timeZone: string
  readonly onOpen: (occurrence: EventOccurrence) => void
}

const HOUR_HEIGHT = 40
const MIN_BLOCK_MINUTES = 28

interface PositionedEvent {
  readonly occurrence: EventOccurrence
  readonly top: number
  readonly height: number
  readonly time: string
}

/**
 * The week's time grid.
 *
 * Only the hours the day actually uses are drawn (padded by one hour on each
 * side), so a single 09:00 meeting does not paint a 24-hour column. The block's
 * top/height come from the event's start minute and duration in the event's
 * zone — the same wall clock the editor wrote.
 */
export function TimeGrid(props: TimeGridProps) {
  const positioned = createMemo<ReadonlyArray<PositionedEvent>>(() =>
    props.occurrences
      .flatMap((occurrence) => {
        const start = occurrenceStartMinutes(occurrence, props.timeZone)
        if (start === null) return []
        const time = occurrenceTimeLabel(occurrence, props.timeZone, props.digits) ?? ""
        return [{ occurrence, start, time }]
      })
      .sort((a, b) => a.start - b.start)
      .map(({ occurrence, start, time }) => {
        const base = windowStart(props.occurrences, props.timeZone)
        return {
          occurrence,
          top: (start - base * 60) * (HOUR_HEIGHT / 60),
          height: Math.max(
            MIN_BLOCK_MINUTES,
            occurrenceDurationMinutes(occurrence)
          ) * (HOUR_HEIGHT / 60),
          time
        }
      })
  )

  const hours = createMemo(() => {
    const base = windowStart(props.occurrences, props.timeZone)
    const end = windowEnd(props.occurrences, props.timeZone)
    return Array.from({ length: end - base }, (_, index) => base + index)
  })

  return (
    <div
      class="calendar-time-grid"
      role="list"
      aria-label="رویدادهای زمانی"
      style={{ height: `${hours().length * HOUR_HEIGHT}px` }}
    >
      <For each={hours()}>
        {(hour) => (
          <div class="calendar-hour" role="listitem" data-hour={hour}>
            <span class="calendar-hour-label">{localizeDigits(pad(hour), props.digits)}</span>
          </div>
        )}
      </For>
      <For each={positioned()}>
        {(entry) => (
          <button
            type="button"
            class="calendar-time-event"
            data-event-key={entry.occurrence.key}
            aria-label={`${entry.time} ${entry.occurrence.title}`}
            style={{
              top: `${entry.top}px`,
              height: `${entry.height}px`
            }}
            onClick={() => props.onOpen(entry.occurrence)}
          >
            <span class="calendar-time-event-time">{entry.time}</span>
            <span class="calendar-time-event-title">{entry.occurrence.title}</span>
          </button>
        )}
      </For>
    </div>
  )
}

const timedStarts = (
  occurrences: ReadonlyArray<EventOccurrence>,
  timeZone: string
): ReadonlyArray<number> =>
  occurrences.flatMap((occurrence) => {
    const start = occurrenceStartMinutes(occurrence, timeZone)
    if (start === null) return []
    return [start]
  })

const timedEnds = (
  occurrences: ReadonlyArray<EventOccurrence>,
  timeZone: string
): ReadonlyArray<number> =>
  occurrences.flatMap((occurrence) => {
    const start = occurrenceStartMinutes(occurrence, timeZone)
    if (start === null) return []
    return [start + occurrenceDurationMinutes(occurrence)]
  })

const windowStart = (
  occurrences: ReadonlyArray<EventOccurrence>,
  timeZone: string
): number => {
  const starts = timedStarts(occurrences, timeZone)
  if (starts.length === 0) return 8
  return Math.max(0, Math.floor(Math.min(...starts) / 60) - 1)
}

const windowEnd = (
  occurrences: ReadonlyArray<EventOccurrence>,
  timeZone: string
): number => {
  const ends = timedEnds(occurrences, timeZone)
  const start = windowStart(occurrences, timeZone)
  if (ends.length === 0) return Math.min(24, start + 3)
  return Math.min(24, Math.max(start + 2, Math.ceil(Math.max(...ends) / 60) + 1))
}

export const hasTimedEvents = (occurrences: ReadonlyArray<EventOccurrence>): boolean =>
  occurrences.some((occurrence) => occurrence.timing._tag === "timed")
