import { createMemo, createSignal, For, Show } from "solid-js"
import { formatJalaliDate, localizeDigits, toJalaliDate, type Digits } from "@tali/domain"
import { useLocalStore } from "../../lib/local-store"
import {
  createOccasionInMirror,
  deleteOccasionInMirror,
  formatAdvanceReminder,
  formatOccasionDate,
  prepareOccasionTaskInMirror,
  updateOccasionInMirror,
  upcomingOccasions,
  type OccasionRow
} from "../../lib/occasions/model"
import {
  OCCASIONS_ALERT,
  OCCASIONS_CARD,
  OCCASIONS_DANGER_BUTTON,
  OCCASIONS_FIELD,
  OCCASIONS_HEAD,
  OCCASIONS_INPUT,
  OCCASIONS_LABEL,
  OCCASIONS_META,
  OCCASIONS_PRIMARY_BUTTON,
  OCCASIONS_ROW,
  OCCASIONS_ROW_ACTIONS,
  OCCASIONS_SMALL_BUTTON
} from "./ui"

/**
 * The occasions panel on `/calendar` (ticket #59; FR-CAL-02).
 *
 * Everything reads and writes the local mirror: an occasion created or edited
 * here is durable offline and travels on the next `/sync/push` (`occasion` is a
 * registry entity). The annual date, the advance-reminder offset and the
 * one-tap preparation task all reuse the shared domain projection, so the panel
 * and the server read model cannot disagree.
 *
 * The panel is deliberately independent of the week/month server read models
 * (#43/#62): occasions are an annual lane, and the calendar screen overlays
 * them from the mirror in both views.
 */

export interface OccasionsPanelProps {
  readonly occasions: ReadonlyArray<OccasionRow>
  /** Today's local date in the viewer's zone (`YYYY-MM-DD`). */
  readonly today: string
  readonly timeZone: string
  readonly digits: Digits
}

const ADVANCE_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "", label: "بدون یادآوری" },
  { value: "0", label: "همان روز" },
  { value: "1", label: "۱ روز قبل" },
  { value: "3", label: "۳ روز قبل" },
  { value: "7", label: "۷ روز قبل" },
  { value: "14", label: "۱۴ روز قبل" },
  { value: "30", label: "۳۰ روز قبل" }
]

const advanceLabel = (days: number | null): string =>
  days === null
    ? "بدون یادآوری پیش از موعد"
    : days === 0
    ? "یادآوری همان روز"
    : `یادآوری ${days.toLocaleString("fa-IR")} روز قبل`

export function OccasionsPanel(props: OccasionsPanelProps) {
  const local = useLocalStore()

  const [editingId, setEditingId] = createSignal<string | undefined>()
  const [title, setTitle] = createSignal("")
  const [originDate, setOriginDate] = createSignal(props.today)
  const [yearly, setYearly] = createSignal(true)
  const [advance, setAdvance] = createSignal("7")
  const [busy, setBusy] = createSignal<string | undefined>()
  const [pageError, setPageError] = createSignal<string>()
  const [announcement, setAnnouncement] = createSignal("")

  const ordered = createMemo(() => upcomingOccasions(props.occasions, props.today))

  const jalaliPreview = createMemo(() => {
    const value = originDate()
    if (value === "") return ""
    try {
      return formatJalaliDate(toJalaliDate(value), { digits: props.digits, style: "medium" })
    } catch {
      return ""
    }
  })

  const reset = () => {
    setEditingId(undefined)
    setTitle("")
    setOriginDate(props.today)
    setYearly(true)
    setAdvance("7")
  }

  const startEditing = (occasion: OccasionRow) => {
    setEditingId(occasion.id)
    setTitle(occasion.title)
    setOriginDate(occasion.originDate)
    setYearly(occasion.yearly)
    setAdvance(occasion.advanceReminderDays === null ? "" : String(occasion.advanceReminderDays))
  }

  const parseAdvance = (): number | null => {
    const value = advance()
    return value === "" ? null : Number(value)
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const store = local.store()
    if (store === undefined || busy() !== undefined) return
    const nextTitle = title().trim()
    if (nextTitle === "" || originDate() === "") return
    setBusy("save")
    setPageError(undefined)
    try {
      const id = editingId()
      if (id === undefined) {
        await createOccasionInMirror(store, {
          title: nextTitle,
          originDate: originDate(),
          timeZone: props.timeZone,
          yearly: yearly(),
          advanceReminderDays: parseAdvance()
        })
        setAnnouncement(`مناسبت «${nextTitle}» افزوده شد`)
      } else {
        await updateOccasionInMirror(store, id, {
          title: nextTitle,
          originDate: originDate(),
          yearly: yearly(),
          advanceReminderDays: parseAdvance()
        })
        setAnnouncement(`مناسبت «${nextTitle}» ویرایش شد`)
      }
      reset()
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : "ذخیره در حافظه‌ی محلی ناموفق بود")
    } finally {
      setBusy(undefined)
    }
  }

  const prepare = async (occasion: OccasionRow) => {
    const store = local.store()
    if (store === undefined || busy() !== undefined) return
    setBusy(`prepare:${occasion.id}`)
    setPageError(undefined)
    try {
      const result = await prepareOccasionTaskInMirror(store, occasion, props.today)
      setAnnouncement(
        result.created
          ? `کار آماده‌سازی برای «${occasion.title}» ساخته شد`
          : `کار آماده‌سازی «${occasion.title}» از قبل ساخته شده است`
      )
    } catch (cause) {
      setPageError(
        cause instanceof Error && cause.message === "this occasion has no upcoming occurrence"
          ? "برای این مناسبت تاریخ بعدی وجود ندارد"
          : cause instanceof Error
          ? cause.message
          : "ساخت کار آماده‌سازی ناموفق بود"
      )
    } finally {
      setBusy(undefined)
    }
  }

  const remove = async (occasion: OccasionRow) => {
    const store = local.store()
    if (store === undefined || busy() !== undefined) return
    setBusy(`delete:${occasion.id}`)
    setPageError(undefined)
    try {
      await deleteOccasionInMirror(store, occasion.id)
      if (editingId() === occasion.id) reset()
      setAnnouncement(`مناسبت «${occasion.title}» حذف شد`)
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : "حذف مناسبت ناموفق بود")
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section style={OCCASIONS_CARD} aria-label="مناسبت‌ها" data-testid="occasions-panel">
      <header style={OCCASIONS_HEAD}>
        <h2 style={{ margin: 0, "font-size": "1rem" }}>مناسبت‌ها</h2>
        <p style={OCCASIONS_META}>
          {localizeDigits(props.occasions.length, props.digits)} مناسبت ثبت شده
        </p>
      </header>

      <p style={OCCASIONS_META}>
        تاریخ‌های مهمی که هر سال در تقویم شمسی تکرار می‌شوند؛ تاریخ میلادی هم کنارشان
        نمایش داده می‌شود.
      </p>

      <form class="grid items-end gap-2 sm:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => void submit(event)}>
        <div style={OCCASIONS_FIELD}>
          <label style={OCCASIONS_LABEL} for="occasion-title">
            عنوان
          </label>
          <input
            id="occasion-title"
            style={OCCASIONS_INPUT}
            aria-label="عنوان مناسبت"
            placeholder="تولد، سالگرد…"
            value={title()}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
        </div>
        <div style={OCCASIONS_FIELD}>
          <label style={OCCASIONS_LABEL} for="occasion-origin">
            تاریخ شروع (میلادی)
          </label>
          <input
            id="occasion-origin"
            type="date"
            style={OCCASIONS_INPUT}
            aria-label="تاریخ شروع مناسبت"
            value={originDate()}
            onInput={(event) => setOriginDate(event.currentTarget.value)}
          />
          <Show when={jalaliPreview() !== ""}>
            <span style={OCCASIONS_META}>{jalaliPreview()}</span>
          </Show>
        </div>
        <div style={OCCASIONS_FIELD}>
          <label style={OCCASIONS_LABEL} for="occasion-advance">
            یادآوری پیش از موعد
          </label>
          <select
            id="occasion-advance"
            style={OCCASIONS_INPUT}
            aria-label="یادآوری پیش از موعد"
            value={advance()}
            onChange={(event) => setAdvance(event.currentTarget.value)}
          >
            <For each={ADVANCE_OPTIONS}>
              {(option) => <option value={option.value}>{option.label}</option>}
            </For>
          </select>
        </div>
        <label class="sm:col-span-2 lg:col-span-3" style={{ ...OCCASIONS_LABEL, display: "flex", gap: "6px", "align-items": "center" }}>
          <input
            type="checkbox"
            checked={yearly()}
            aria-label="هر سال تکرار شود"
            onChange={(event) => setYearly(event.currentTarget.checked)}
          />
          هر سال تکرار شود
        </label>
        <div class="sm:col-span-2 lg:col-span-3" style={OCCASIONS_ROW_ACTIONS}>
          <button
            type="submit"
            style={OCCASIONS_PRIMARY_BUTTON}
            disabled={
              local.store() === undefined ||
              busy() === "save" ||
              title().trim() === "" ||
              originDate() === ""
            }
          >
            {editingId() === undefined ? "افزودن مناسبت" : "ذخیرهٔ ویرایش"}
          </button>
          <Show when={editingId() !== undefined}>
            <button type="button" style={OCCASIONS_SMALL_BUTTON()} onClick={reset}>
              انصراف
            </button>
          </Show>
        </div>
      </form>

      <Show
        when={ordered().length > 0}
        fallback={
          <p style={OCCASIONS_META}>
            هنوز مناسبت‌ی ثبت نشده است. تولدها و سالگردها را این‌جا اضافه کنید تا هر سال
            خودشان در تقویم بیایند.
          </p>
        }
      >
        <ul style={{ "list-style": "none", margin: 0, padding: 0 }}>
          <For each={ordered()}>
            {(entry) => (
              <li style={OCCASIONS_ROW} data-occasion-id={entry.occasion.id}>
                <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
                  <Show when={entry.occasion.color !== null}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: "9px",
                        height: "9px",
                        "border-radius": "50%",
                        background: entry.occasion.color ?? "transparent",
                        flex: "none"
                      }}
                    />
                  </Show>
                  <strong style={{ "font-size": "0.92rem" }}>{entry.occasion.title}</strong>
                  <Show when={!entry.occasion.yearly}>
                    <span style={OCCASIONS_META}>یک‌بار</span>
                  </Show>
                </div>
                <Show
                  when={entry.occurrence}
                  fallback={<p style={OCCASIONS_META}>تاریخ این مناسبت گذشته است.</p>}
                >
                  {(occurrence) => (
                    <>
                      <p style={{ ...OCCASIONS_META, margin: 0 }}>
                        {formatOccasionDate(occurrence(), props.digits)}
                      </p>
                      <p style={{ ...OCCASIONS_META, margin: 0 }}>
                        {formatAdvanceReminder(occurrence(), props.digits) ??
                          advanceLabel(entry.occasion.advanceReminderDays)}
                      </p>
                    </>
                  )}
                </Show>
                <div class="sm:col-span-2 lg:col-span-3" style={OCCASIONS_ROW_ACTIONS}>
                  <button
                    type="button"
                    style={OCCASIONS_SMALL_BUTTON(entry.occasion.preparationTaskId !== null)}
                    aria-label={`آماده‌سازی ${entry.occasion.title}`}
                    disabled={local.store() === undefined || busy() === `prepare:${entry.occasion.id}`}
                    onClick={() => void prepare(entry.occasion)}
                  >
                    {entry.occasion.preparationTaskId === null
                      ? "آماده‌سازی"
                      : "آماده‌سازی ساخته شده"}
                  </button>
                  <button
                    type="button"
                    style={OCCASIONS_SMALL_BUTTON()}
                    aria-label={`ویرایش ${entry.occasion.title}`}
                    onClick={() => startEditing(entry.occasion)}
                  >
                    ویرایش
                  </button>
                  <button
                    type="button"
                    style={OCCASIONS_DANGER_BUTTON}
                    aria-label={`حذف ${entry.occasion.title}`}
                    disabled={local.store() === undefined || busy() === `delete:${entry.occasion.id}`}
                    onClick={() => void remove(entry.occasion)}
                  >
                    حذف
                  </button>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={pageError()}>
        <p style={OCCASIONS_ALERT} role="alert">
          {pageError()}
        </p>
      </Show>
      <p style={{ ...OCCASIONS_META, margin: 0 }} role="status" aria-live="polite">
        {announcement()}
      </p>
    </section>
  )
}
