import { createSignal, onSettled, Show, untrack } from "solid-js"
import { Title } from "@solidjs/meta"
import { useNavigate } from "@solidjs/router"
import { Button, tokens } from "@tali/ui"
import type { CreateHouseholdInput, InviteCode, JoinHouseholdInput } from "@tali/domain"
import { AuthCard, Field, FormError, TextInput } from "../components/form"
import { Guard } from "../components/guard"
import { useAuth, type HouseholdSummary } from "../lib/auth"
import { authErrorMessage } from "../lib/auth-copy"

/**
 * The shared-space step between registering and using the app: the first user
 * creates the household (and gets an invite code for the second), the second
 * user joins with that code.
 */
export default function HouseholdRoute() {
  return (
    <>
      <Title>خانه‌ی مشترک — تالی</Title>
      <Guard access="session">
        <HouseholdPage />
      </Guard>
    </>
  )
}

function HouseholdPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const [created, setCreated] = createSignal<HouseholdSummary>()
  // Snapshot at mount: someone who already belongs to a household has no
  // business here, but creating one *in* this screen must not skip the invite.
  const alreadyInHousehold = untrack(() => auth.householdId() !== undefined)

  onSettled(() => {
    if (alreadyInHousehold) {
      navigate("/today", { replace: true })
    }
  })

  return (
    <AuthCard
      title="خانه‌ی مشترک"
      subtitle="تالی برای دو نفر ساخته شده: یک خانه، دو حساب. یکی خانه را می‌سازد و دیگری با کد دعوت به آن می‌پیوندد."
    >
      <Show
        when={created()}
        fallback={
          <>
            <Show when={auth.session()?.user.displayName}>
              {(name) => (
                <p style={{ margin: 0, "font-size": "0.9rem", color: tokens.color.inkSoft }}>
                  خوش آمدید، {name()}.
                </p>
              )}
            </Show>
            <CreateHousehold onCreated={setCreated} />
            <Divider />
            <JoinHousehold />
          </>
        }
      >
        {(summary) => <InvitePanel summary={summary()} onContinue={() => navigate("/today")} />}
      </Show>
    </AuthCard>
  )
}

function Divider() {
  return (
    <div
      role="separator"
      style={{ display: "flex", "align-items": "center", gap: "10px", color: tokens.color.inkSoft }}
    >
      <span style={{ flex: 1, height: "1px", background: tokens.color.line }} />
      <span style={{ "font-size": "0.8rem", opacity: 0.8 }}>یا</span>
      <span style={{ flex: 1, height: "1px", background: tokens.color.line }} />
    </div>
  )
}

function CreateHousehold(props: { onCreated: (summary: HouseholdSummary) => void }) {
  const auth = useAuth()

  const [name, setName] = createSignal("خانه‌ی ما")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy()) return

    if (name().trim() === "") {
      setError("نام خانه را وارد کنید.")
      return
    }

    setBusy(true)
    setError(undefined)
    const input: CreateHouseholdInput = { name: name().trim() }
    const result = await auth.createHousehold(input)
    setBusy(false)

    if (result.ok) {
      props.onCreated(result.value)
    } else {
      setError(authErrorMessage(result.error.code))
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: "12px" }}>
      <h2 style={{ margin: 0, "font-size": "1.05rem" }}>ساختن خانه</h2>
      <Field label="نام خانه" for="household-name">
        <TextInput
          id="household-name"
          name="householdName"
          value={name()}
          disabled={busy()}
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </Field>
      <FormError message={error()} />
      <Button type="submit" disabled={busy()} style={{ width: "100%" }}>
        {busy() ? "در حال ساختن…" : "ساختن خانه"}
      </Button>
    </form>
  )
}

function InvitePanel(props: { summary: HouseholdSummary; onContinue: () => void }) {
  const [copied, setCopied] = createSignal(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.summary.inviteCode)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div style={{ display: "grid", gap: "12px" }}>
      <h2 style={{ margin: 0, "font-size": "1.05rem" }}>خانه ساخته شد</h2>
      <p style={{ margin: 0, "font-size": "0.9rem", color: tokens.color.inkSoft, "line-height": "1.9" }}>
        کد دعوت «{props.summary.name}» را برای نفر دوم بفرستید. او با این کد به خانه می‌پیوندد.
      </p>
      <code
        dir="ltr"
        style={{
          display: "block",
          padding: "12px",
          "border-radius": tokens.radius.md,
          background: "#f5f7fc",
          border: `1px dashed ${tokens.color.line}`,
          "text-align": "center",
          "font-size": "1rem",
          "letter-spacing": "0.08em",
          "word-break": "break-all"
        }}
      >
        {props.summary.inviteCode}
      </code>
      <div style={{ display: "flex", gap: tokens.space.sm }}>
        <Button variant="ghost" type="button" onClick={() => void copy()}>
          {copied() ? "کپی شد" : "کپی کد"}
        </Button>
        <Button type="button" onClick={props.onContinue} style={{ flex: 1 }}>
          ادامه به امروز
        </Button>
      </div>
    </div>
  )
}

function JoinHousehold() {
  const auth = useAuth()
  const navigate = useNavigate()

  const [code, setCode] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy()) return

    if (code().trim() === "") {
      setError("کد دعوت را وارد کنید.")
      return
    }

    setBusy(true)
    setError(undefined)
    const input: JoinHouseholdInput = { inviteCode: code().trim() as InviteCode }
    const result = await auth.joinHousehold(input)
    setBusy(false)

    if (result.ok) {
      navigate("/today", { replace: true })
    } else {
      setError(authErrorMessage(result.error.code))
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: "12px" }}>
      <h2 style={{ margin: 0, "font-size": "1.05rem" }}>پیوستن به خانه</h2>
      <Field label="کد دعوت" for="household-invite">
        <TextInput
          id="household-invite"
          name="inviteCode"
          dir="ltr"
          autocomplete="off"
          value={code()}
          disabled={busy()}
          onInput={(event) => setCode(event.currentTarget.value)}
        />
      </Field>
      <FormError message={error()} />
      <Button type="submit" variant="ghost" disabled={busy()} style={{ width: "100%" }}>
        {busy() ? "در حال پیوستن…" : "پیوستن"}
      </Button>
    </form>
  )
}
