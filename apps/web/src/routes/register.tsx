import { createSignal } from "solid-js"
import { Title } from "@solidjs/meta"
import { useNavigate } from "@solidjs/router"
import { Button } from "@tali/ui"
import type { Email, RegisterInput } from "@tali/domain"
import { AuthCard, AuthFooterLink, Field, FormError, TextInput } from "../components/form"
import { Guard, landingPath } from "../components/guard"
import { useAuth } from "../lib/auth"
import { authErrorMessage } from "../lib/auth-copy"

/**
 * Detect the browser's IANA zone so a new account gets sensible date/reminder
 * defaults without asking. The settings screen can change it later.
 */
const detectedTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tehran"
  } catch {
    return "Asia/Tehran"
  }
}

export default function RegisterRoute() {
  return (
    <>
      <Title>ثبت‌نام — تالی</Title>
      <Guard access="guest">
        <RegisterPage />
      </Guard>
    </>
  )
}

function RegisterPage() {
  const auth = useAuth()
  const navigate = useNavigate()

  const [displayName, setDisplayName] = createSignal("")
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const validate = (): string | undefined => {
    if (displayName().trim() === "") return "نام نمایشی را وارد کنید."
    if (!/^\s*[^\s@]+@[^\s@]+\.[^\s@]+\s*$/.test(email())) return "ایمیل معتبر وارد کنید."
    if (password().length < 8) return "گذرواژه باید حداقل ۸ نویسه باشد."
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

    setBusy(true)
    setError(undefined)
    const input: RegisterInput = {
      email: email().trim() as Email,
      password: password(),
      displayName: displayName().trim(),
      timeZone: detectedTimeZone()
    }
    const result = await auth.signUp(input)
    setBusy(false)

    if (result.ok) {
      navigate(landingPath(auth.householdId()), { replace: true })
    } else {
      setError(authErrorMessage(result.error.code))
    }
  }

  return (
    <AuthCard
      title="ساخت حساب"
      subtitle="برای شروع، یک حساب بسازید؛ بعد خانه‌ی مشترک را می‌سازید یا به آن می‌پیوندید."
      footer={<AuthFooterLink href="/login" text="حساب دارید؟" linkText="وارد شوید" />}
    >
      <form onSubmit={submit} style={{ display: "grid", gap: "14px" }}>
        <Field label="نام نمایشی" for="register-name">
          <TextInput
            id="register-name"
            name="displayName"
            autocomplete="name"
            value={displayName()}
            disabled={busy()}
            onInput={(event) => setDisplayName(event.currentTarget.value)}
          />
        </Field>

        <Field label="ایمیل" for="register-email">
          <TextInput
            id="register-email"
            type="email"
            name="email"
            autocomplete="email"
            dir="ltr"
            value={email()}
            disabled={busy()}
            onInput={(event) => setEmail(event.currentTarget.value)}
          />
        </Field>

        <Field label="گذرواژه" for="register-password" hint="حداقل ۸ نویسه">
          <TextInput
            id="register-password"
            type="password"
            name="password"
            autocomplete="new-password"
            value={password()}
            disabled={busy()}
            onInput={(event) => setPassword(event.currentTarget.value)}
          />
        </Field>

        <FormError message={error()} />

        <Button type="submit" disabled={busy()} style={{ width: "100%" }}>
          {busy() ? "در حال ساخت…" : "ساخت حساب"}
        </Button>
      </form>
    </AuthCard>
  )
}
