import { createEffect, createSignal, For, Show } from "solid-js"
import { Title } from "@solidjs/meta"
import { Button, tokens } from "@tali/ui"
import {
  DEFAULT_TIME_ZONE,
  formatJalaliDate,
  todayInTimeZone,
  type Digits,
  type LoginKey,
  type WeekStart
} from "@tali/domain"
import { AppHeader } from "../components/app-header"
import { Field, FormError, Select, TextInput } from "../components/form"
import { Guard } from "../components/guard"
import { PushHealthPanel } from "../components/push-health"
import { useAuth } from "../lib/auth"
import { authErrorMessage } from "../lib/auth-copy"
import { deriveLoginKey, passwordProblem } from "../lib/login-key"
import { changedDisplayFields, usePreferences } from "../lib/preferences"

/**
 * Account settings (ticket #25) plus display preferences (ticket #35) and the
 * device's notification health (ticket #20).
 *
 * The preference form writes through `PATCH /preferences` and the store
 * updates the cached signal immediately, so `/today`'s Jalali week and digits
 * change without a reload. Time zone is validated as a real IANA zone here
 * (the API validates again); week start and digits are closed choices.
 *
 * The credential form is unchanged: both passwords are stretched to login keys
 * in the browser, so the API verifies the old key and stores a fresh verifier
 * without ever seeing a password.
 */

/** Common zones as datalist hints; any real IANA identifier is accepted. */
const TIME_ZONE_SUGGESTIONS = [
  "Asia/Tehran",
  "Asia/Dubai",
  "Asia/Istanbul",
  "Asia/Kabul",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "Australia/Sydney",
  "UTC"
] as const

const WEEK_START_OPTIONS: ReadonlyArray<{ value: WeekStart; label: string }> = [
  { value: "saturday", label: "شنبه" },
  { value: "sunday", label: "یکشنبه" },
  { value: "monday", label: "دوشنبه" }
]

const DIGITS_OPTIONS: ReadonlyArray<{ value: Digits; label: string }> = [
  { value: "persian", label: "فارسی (۱۲۳)" },
  { value: "latin", label: "لاتین (123)" }
]

const isIanaTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}

export default function SettingsRoute() {
  return (
    <>
      <Title>تنظیمات — تالی</Title>
      <Guard access="session">
        <SettingsPage />
      </Guard>
    </>
  )
}

function SettingsPage() {
  const auth = useAuth()
  const preferences = usePreferences()
  const [current, setCurrent] = createSignal("")
  const [next, setNext] = createSignal("")
  const [confirm, setConfirm] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [done, setDone] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  // Display drafts; kept in sync when the server/cache answers.
  const [timeZone, setTimeZone] = createSignal(preferences.preferences().timeZone)
  const [weekStart, setWeekStart] = createSignal<WeekStart>(
    preferences.preferences().weekStart
  )
  const [digits, setDigits] = createSignal<Digits>(preferences.preferences().digits)
  const [displayError, setDisplayError] = createSignal<string>()
  const [displayDone, setDisplayDone] = createSignal(false)

  createEffect(
    () => preferences.preferences(),
    (saved) => {
      setTimeZone(saved.timeZone)
      setWeekStart(saved.weekStart)
      setDigits(saved.digits)
    }
  )

  /** Today's Jalali date in the drafted zone + digits, for instant feedback. */
  const preview = (): string => {
    try {
      const zone = isIanaTimeZone(timeZone()) ? timeZone() : DEFAULT_TIME_ZONE
      return formatJalaliDate(todayInTimeZone(zone), { digits: digits() })
    } catch {
      return formatJalaliDate(todayInTimeZone(DEFAULT_TIME_ZONE), { digits: digits() })
    }
  }

  const saveDisplay = async (event: SubmitEvent) => {
    event.preventDefault()
    if (preferences.saving()) return

    const zone = timeZone().trim()
    if (!isIanaTimeZone(zone)) {
      setDisplayError("منطقه‌ی زمانی معتبر نیست؛ مثل Asia/Tehran وارد کنید.")
      setDisplayDone(false)
      return
    }

    setDisplayError(undefined)
    setDisplayDone(false)
    // Only the fields this screen actually changed: an untouched draft may be
    // a profile default or an old cache that the server has since outgrown,
    // and sending it would silently revert the other device's choice.
    const result = await preferences.update(
      changedDisplayFields(preferences.preferences(), {
        timeZone: zone,
        weekStart: weekStart(),
        digits: digits()
      })
    )
    if (result.ok) {
      setDisplayDone(true)
    } else {
      setDisplayError(authErrorMessage(result.code))
    }
  }

  const validate = (): string | undefined => {
    if (current() === "") return "گذرواژه‌ی فعلی را وارد کنید."
    const problem = passwordProblem(next())
    if (problem !== undefined) return problem
    if (next() !== confirm()) return "گذرواژه‌ی تازه و تکرار آن یکسان نیست."
    return undefined
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy()) return

    const problem = validate()
    if (problem !== undefined) {
      setError(problem)
      return
    }

    const email = auth.session()?.user.email
    if (email === undefined) {
      setError(authErrorMessage("Unauthorized"))
      return
    }

    setBusy(true)
    setError(undefined)
    setDone(false)

    let currentLoginKey: LoginKey
    let newLoginKey: LoginKey
    try {
      currentLoginKey = await deriveLoginKey(current(), email)
      newLoginKey = await deriveLoginKey(next(), email)
    } catch {
      setBusy(false)
      setError(authErrorMessage("InternalError"))
      return
    }

    const result = await auth.changePassword({ currentLoginKey, newLoginKey })
    setBusy(false)

    if (result.ok) {
      setCurrent("")
      setNext("")
      setConfirm("")
      setDone(true)
    } else {
      setError(authErrorMessage(result.error.code))
    }
  }

  return (
    <div
      class="settings-root"
      dir="rtl"
      lang="fa"
      style={{ "min-height": "100dvh", background: tokens.color.canvas, color: tokens.color.ink }}
    >
      <AppHeader active="settings" />
      <main class="settings-main">
        <header class="settings-heading">
          <h1>تنظیمات</h1>
          <p>گذرواژه فقط در همین مرورگر به کلید ورود تبدیل می‌شود و به سرور نمی‌رسد.</p>
        </header>
      <section
        class="settings-card"
        aria-labelledby="settings-display-title"
        style={{ display: "grid", gap: "14px" }}
      >
        <header style={{ display: "grid", gap: "4px" }}>
          <h2 id="settings-display-title" style={{ margin: 0, "font-size": "1.05rem" }}>
            نمایش
          </h2>
          <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.85rem", "line-height": "1.8" }}>
            تقویم شمسی، شروع هفته و شکل اعداد را اینجا تغییر دهید.
          </p>
        </header>

        <form onSubmit={(event) => void saveDisplay(event)} style={{ display: "grid", gap: "14px" }}>
          <Field label="منطقه‌ی زمانی (IANA)" for="settings-timezone" hint="مثل Asia/Tehran">
            <TextInput
              id="settings-timezone"
              name="timeZone"
              list="settings-timezone-options"
              dir="ltr"
              autocomplete="off"
              spellcheck={false}
              value={timeZone()}
              disabled={preferences.saving()}
              onInput={(event) => setTimeZone(event.currentTarget.value)}
            />
            <datalist id="settings-timezone-options">
              <For each={TIME_ZONE_SUGGESTIONS}>{(zone) => <option value={zone} />}</For>
            </datalist>
          </Field>

          <Field label="شروع هفته" for="settings-week-start">
            <Select
              id="settings-week-start"
              name="weekStart"
              value={weekStart()}
              disabled={preferences.saving()}
              onChange={(event) =>
                setWeekStart(event.currentTarget.value as WeekStart)
              }
            >
              <For each={WEEK_START_OPTIONS}>
                {(option) => <option value={option.value}>{option.label}</option>}
              </For>
            </Select>
          </Field>

          <Field label="شکل اعداد" for="settings-digits">
            <Select
              id="settings-digits"
              name="digits"
              value={digits()}
              disabled={preferences.saving()}
              onChange={(event) => setDigits(event.currentTarget.value as Digits)}
            >
              <For each={DIGITS_OPTIONS}>
                {(option) => <option value={option.value}>{option.label}</option>}
              </For>
            </Select>
          </Field>

          <p
            aria-live="polite"
            style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.88rem" }}
          >
            امروز: {preview()}
          </p>

          <FormError message={displayError()} />
          <Show when={displayDone()}>
            <p role="status" style={{ margin: 0, "font-size": "0.88rem", color: "#166534" }}>
              تنظیمات نمایش ذخیره شد.
            </p>
          </Show>

          <Button type="submit" disabled={preferences.saving()} style={{ width: "100%" }}>
            {preferences.saving() ? "در حال ذخیره…" : "ذخیره‌ی تنظیمات نمایش"}
          </Button>
        </form>
      </section>

      <form class="settings-card" onSubmit={submit} style={{ display: "grid", gap: "14px" }}>
        <h2 style={{ margin: 0, "font-size": "1.05rem" }}>گذرواژه</h2>

        <Field label="گذرواژه‌ی فعلی" for="settings-current">
          <TextInput
            id="settings-current"
            type="password"
            name="currentPassword"
            autocomplete="current-password"
            value={current()}
            disabled={busy()}
            onInput={(event) => setCurrent(event.currentTarget.value)}
          />
        </Field>

        <Field label="گذرواژه‌ی تازه" for="settings-new" hint="حداقل ۱۲ نویسه">
          <TextInput
            id="settings-new"
            type="password"
            name="newPassword"
            autocomplete="new-password"
            value={next()}
            disabled={busy()}
            onInput={(event) => setNext(event.currentTarget.value)}
          />
        </Field>

        <Field label="تکرار گذرواژه‌ی تازه" for="settings-confirm">
          <TextInput
            id="settings-confirm"
            type="password"
            name="confirmPassword"
            autocomplete="new-password"
            value={confirm()}
            disabled={busy()}
            onInput={(event) => setConfirm(event.currentTarget.value)}
          />
        </Field>

        <FormError message={error()} />
        {done() ? (
          <p role="status" style={{ margin: 0, "font-size": "0.88rem", color: "#166534" }}>
            گذرواژه تغییر کرد.
          </p>
        ) : null}

        <Button type="submit" disabled={busy()} style={{ width: "100%" }}>
          {busy() ? "در حال ذخیره…" : "تغییر گذرواژه"}
        </Button>
      </form>

      <PushHealthPanel />
      </main>
    </div>
  )
}
