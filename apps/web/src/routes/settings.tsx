import { createSignal } from "solid-js"
import { Title } from "@solidjs/meta"
import { useNavigate } from "@solidjs/router"
import { Button, tokens } from "@tali/ui"
import type { LoginKey } from "@tali/domain"
import { AuthCard, Field, FormError, TextInput } from "../components/form"
import { Guard } from "../components/guard"
import { useAuth } from "../lib/auth"
import { authErrorMessage } from "../lib/auth-copy"
import { deriveLoginKey, passwordProblem } from "../lib/login-key"

/**
 * Account settings (ticket #25). Today this is only the credential swap: both
 * the current and the new password are stretched to login keys in the browser,
 * so the API verifies the old key and stores a fresh verifier without ever
 * seeing a password.
 */
export default function SettingsRoute() {
  return (
    <>
      <Title>تنظیمات حساب — تالی</Title>
      <Guard access="session">
        <SettingsPage />
      </Guard>
    </>
  )
}

function SettingsPage() {
  const auth = useAuth()
  const navigate = useNavigate()

  const [current, setCurrent] = createSignal("")
  const [next, setNext] = createSignal("")
  const [confirm, setConfirm] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [done, setDone] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

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
    <AuthCard
      title="تنظیمات حساب"
      subtitle="گذرواژه فقط در همین مرورگر به کلید ورود تبدیل می‌شود و به سرور نمی‌رسد."
      footer={
        <nav style={{ "text-align": "center", "font-size": "0.9rem" }}>
          <a
            href="/today"
            onClick={(event) => {
              event.preventDefault()
              navigate(auth.householdId() === undefined ? "/household" : "/today")
            }}
            style={{ color: tokens.color.brand, "text-decoration": "none" }}
          >
            بازگشت
          </a>
        </nav>
      }
    >
      <form onSubmit={submit} style={{ display: "grid", gap: "14px" }}>
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
    </AuthCard>
  )
}
