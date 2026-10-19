import { createSignal } from "solid-js"
import { Title } from "@solidjs/meta"
import { useNavigate } from "@solidjs/router"
import { Button } from "@tali/ui"
import type { Email, LoginKey } from "@tali/domain"
import { AuthCard, AuthFooterLink, Field, FormError, TextInput } from "../components/form"
import { Guard, landingPath } from "../components/guard"
import { useAuth } from "../lib/auth"
import { authErrorMessage } from "../lib/auth-copy"
import { deriveLoginKey } from "../lib/login-key"

export default function LoginRoute() {
  return (
    <>
      <Title>ورود — تالی</Title>
      <Guard access="guest">
        <LoginPage />
      </Guard>
    </>
  )
}

function LoginPage() {
  const auth = useAuth()
  const navigate = useNavigate()

  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy()) return

    if (email().trim() === "" || password() === "") {
      setError("ایمیل و گذرواژه را وارد کنید.")
      return
    }

    setBusy(true)
    setError(undefined)

    const emailInput = email().trim() as Email
    let loginKey: LoginKey
    try {
      loginKey = await deriveLoginKey(password(), emailInput)
    } catch {
      setBusy(false)
      setError(authErrorMessage("InternalError"))
      return
    }

    const result = await auth.signIn({ email: emailInput, loginKey })
    setBusy(false)

    if (result.ok) {
      navigate(landingPath(auth.householdId()), { replace: true })
    } else {
      setError(authErrorMessage(result.error.code))
    }
  }

  return (
    <AuthCard
      title="ورود به تالی"
      subtitle="برنامه‌ریز مشترک خانه‌ی شما."
      footer={<AuthFooterLink href="/register" text="حساب ندارید؟" linkText="ثبت‌نام کنید" />}
    >
      <form onSubmit={submit} style={{ display: "grid", gap: "14px" }}>
        <Field label="ایمیل" for="login-email">
          <TextInput
            id="login-email"
            type="email"
            name="email"
            autocomplete="email"
            dir="ltr"
            value={email()}
            disabled={busy()}
            onInput={(event) => setEmail(event.currentTarget.value)}
          />
        </Field>

        <Field label="گذرواژه" for="login-password">
          <TextInput
            id="login-password"
            type="password"
            name="password"
            autocomplete="current-password"
            value={password()}
            disabled={busy()}
            onInput={(event) => setPassword(event.currentTarget.value)}
          />
        </Field>

        <FormError message={error()} />

        <Button type="submit" disabled={busy()} style={{ width: "100%" }}>
          {busy() ? "در حال ورود…" : "ورود"}
        </Button>
      </form>
    </AuthCard>
  )
}
