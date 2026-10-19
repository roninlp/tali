import { tokens } from "@tali/ui"

export default function NotFound() {
  return (
    <main
      dir="rtl"
      lang="fa"
      style={{
        "min-height": "100dvh",
        display: "grid",
        "place-items": "center",
        padding: tokens.space.md,
        "font-family": tokens.font.sans,
        color: tokens.color.ink
      }}
    >
      <section style={{ display: "grid", gap: tokens.space.sm, "justify-items": "center", "text-align": "center" }}>
        <h1 style={{ margin: 0, "font-size": "1.4rem" }}>صفحه پیدا نشد</h1>
        <p style={{ margin: 0, color: tokens.color.inkSoft }}>نشانی‌ای که باز کردید وجود ندارد.</p>
        <a href="/" style={{ color: tokens.color.brand, "text-decoration": "none" }}>
          بازگشت به تالی
        </a>
      </section>
    </main>
  )
}
