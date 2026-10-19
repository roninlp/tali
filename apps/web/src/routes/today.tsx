import { createSignal, Show } from "solid-js"
import { Title } from "@solidjs/meta"
import { useNavigate } from "@solidjs/router"
import { Button, tokens } from "@tali/ui"
import { Guard } from "../components/guard"
import { FormError } from "../components/form"
import { useAuth } from "../lib/auth"
import { authErrorMessage } from "../lib/auth-copy"

export default function TodayRoute() {
  return (
    <>
      <Title>امروز — تالی</Title>
      <Guard access="household">
        <TodayPage />
      </Guard>
    </>
  )
}

/**
 * The first signed-in screen. Slice 2 fills it with the dashboard sections;
 * for now it proves the session + household gates and gives the shell its
 * header (brand, account, logout).
 */
function TodayPage() {
  const auth = useAuth()
  const navigate = useNavigate()

  const [signOutBusy, setSignOutBusy] = createSignal(false)
  const [signOutError, setSignOutError] = createSignal<string>()

  const name = () => auth.session()?.user.displayName ?? ""

  const signOut = async () => {
    if (signOutBusy()) return
    setSignOutBusy(true)
    setSignOutError(undefined)
    const result = await auth.signOut()
    setSignOutBusy(false)
    if (result.ok) {
      navigate("/login", { replace: true })
    } else {
      // The server still holds the session; say so instead of pretending.
      setSignOutError(authErrorMessage(result.error.code))
    }
  }

  return (
    <div
      dir="rtl"
      lang="fa"
      style={{
        "min-height": "100dvh",
        "font-family": tokens.font.sans,
        color: tokens.color.ink,
        background: "#f7f9fd"
      }}
    >
      <header
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          gap: tokens.space.md,
          padding: `${tokens.space.md} ${tokens.space.lg}`,
          background: tokens.color.surface,
          "border-bottom": `1px solid ${tokens.color.line}`
        }}
      >
        <div style={{ display: "grid", gap: "2px" }}>
          <strong style={{ "font-size": "1.1rem", color: tokens.color.brand }}>تالی</strong>
          <Show when={auth.session()?.user.displayName}>
            {(displayName) => (
              <span style={{ "font-size": "0.85rem", color: tokens.color.inkSoft }}>{displayName()}</span>
            )}
          </Show>
        </div>
        <Button variant="ghost" type="button" disabled={signOutBusy()} onClick={() => void signOut()}>
          {signOutBusy() ? "در حال خروج…" : "خروج"}
        </Button>
      </header>

      <main style={{ padding: tokens.space.lg, display: "grid", gap: tokens.space.md, "max-width": "720px" }}>
        <h1 style={{ margin: 0, "font-size": "1.5rem" }}>امروز</h1>
        <FormError message={signOutError()} />
        <section
          style={{
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.line}`,
            "border-radius": tokens.radius.lg,
            padding: tokens.space.lg,
            "line-height": "2"
          }}
        >
          <p style={{ margin: 0 }}>سلام {name()} — به تالی خوش آمدید.</p>
          <p style={{ margin: "8px 0 0", color: tokens.color.inkSoft, "font-size": "0.92rem" }}>
            اینجا به‌زودی کارها، یادداشت‌ها و عادت‌های امروز را می‌بینید.
          </p>
        </section>
      </main>
    </div>
  )
}
