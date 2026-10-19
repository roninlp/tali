import { createEffect, createSignal, For, Show } from "solid-js"
import { Title } from "@solidjs/meta"
import { useNavigate } from "@solidjs/router"
import { Button, tokens } from "@tali/ui"
import { DEFAULT_TIME_ZONE, formatJalaliDate, todayInTimeZone, uuidV7 } from "@tali/domain"
import { Guard } from "../components/guard"
import { FormError, TextInput } from "../components/form"
import { SyncStatus } from "../components/sync-status"
import { useAuth } from "../lib/auth"
import { authErrorMessage } from "../lib/auth-copy"
import { useLocalStore } from "../lib/local-store"
import type { MirrorRecord } from "../lib/local-store"

const DRAFT_KEY = "today.quickAdd.title"

const titleOf = (row: MirrorRecord): string =>
  typeof row.data.title === "string" ? row.data.title : ""

const checkedOf = (row: MirrorRecord): boolean => row.data.checked === true

const sortOrderOf = (row: MirrorRecord): number =>
  typeof row.data.sortOrder === "number" ? row.data.sortOrder : 0

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
 * today it proves the local-first loop: a write lands in the IndexedDB mirror
 * (and the outbox) before anything touches the network, survives a reload,
 * and the header says whether the device is offline or still has queued work.
 */
function TodayPage() {
  const auth = useAuth()
  const local = useLocalStore()
  const navigate = useNavigate()

  const [signOutBusy, setSignOutBusy] = createSignal(false)
  const [signOutError, setSignOutError] = createSignal<string>()
  const [items, setItems] = createSignal<ReadonlyArray<MirrorRecord>>([])
  const [draft, setDraft] = createSignal("")
  const [addBusy, setAddBusy] = createSignal(false)

  let draftTimer: ReturnType<typeof setTimeout> | undefined

  const name = () => auth.session()?.user.displayName ?? ""
  const digits = () => auth.session()?.user.digits ?? "persian"
  const today = () => {
    try {
      return todayInTimeZone(auth.session()?.user.timeZone ?? DEFAULT_TIME_ZONE)
    } catch {
      return todayInTimeZone(DEFAULT_TIME_ZONE)
    }
  }
  const sorted = () => [...items()].sort((a, b) => sortOrderOf(a) - sortOrderOf(b))

  // Hydrate from the mirror as soon as the store opens; the outbox is replayed
  // into the mirror by construction (writeLocal writes both together), so the
  // screen already shows the user's intent before any server contact.
  createEffect(
    () => local.store(),
    (store) => {
      if (store === undefined) {
        setItems([])
        return
      }
      let cancelled = false
      const reload = () => {
        void store
          .list("listItem")
          .then((rows) => {
            if (!cancelled) setItems(rows)
          })
          .catch(() => {
            // The store closed (sign-out) while the read was in flight.
          })
      }
      reload()
      const unsubscribe = store.subscribe(reload)

      // Recover a half-typed quick-add after a reload or an accidental close.
      void store.readDraft(DRAFT_KEY).then((saved) => {
        if (cancelled || saved === undefined) return
        setDraft((current) => (current === "" ? saved : current))
      }).catch(() => {
        // Drafts are best-effort; a read failure must not block the list.
      })

      return () => {
        cancelled = true
        unsubscribe()
      }
    }
  )

  const updateDraft = (value: string) => {
    setDraft(value)
    const store = local.store()
    if (store === undefined) return
    clearTimeout(draftTimer)
    draftTimer = setTimeout(() => {
      if (value.trim() === "") void store.clearDraft(DRAFT_KEY)
      else void store.saveDraft(DRAFT_KEY, value)
    }, 300)
  }

  const addItem = async (event: SubmitEvent) => {
    event.preventDefault()
    const store = local.store()
    const title = draft().trim()
    if (store === undefined || title === "" || addBusy()) return

    setAddBusy(true)
    try {
      const now = new Date().toISOString()
      const id = uuidV7()
      const nextOrder = items().reduce((max, row) => Math.max(max, sortOrderOf(row)), -1) + 1
      await store.writeLocal({
        entityType: "listItem",
        entityId: id,
        op: "upsert",
        patch: { id, title, checked: false, sortOrder: nextOrder, createdAt: now },
        now
      })
      clearTimeout(draftTimer)
      setDraft("")
      await store.clearDraft(DRAFT_KEY)
    } finally {
      setAddBusy(false)
    }
  }

  const toggleItem = async (row: MirrorRecord) => {
    const store = local.store()
    if (store === undefined) return
    const now = new Date().toISOString()
    await store.writeLocal({
      entityType: "listItem",
      entityId: row.entityId,
      op: "upsert",
      patch: { checked: !checkedOf(row) },
      now
    })
  }

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
          "border-bottom": `1px solid ${tokens.color.line}`,
          "flex-wrap": "wrap"
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
        <div style={{ display: "flex", "align-items": "center", gap: tokens.space.sm }}>
          <SyncStatus />
          <Button variant="ghost" type="button" onClick={() => navigate("/settings")}>
            تنظیمات
          </Button>
          <Button variant="ghost" type="button" disabled={signOutBusy()} onClick={() => void signOut()}>
            {signOutBusy() ? "در حال خروج…" : "خروج"}
          </Button>
        </div>
      </header>

      <main style={{ padding: tokens.space.lg, display: "grid", gap: tokens.space.md, "max-width": "720px" }}>
        <h1 style={{ margin: 0, "font-size": "1.5rem" }}>امروز</h1>
        <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.9rem" }}>
          {formatJalaliDate(today(), { digits: digits() })}
        </p>
        <FormError message={signOutError()} />

        <section
          style={{
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.line}`,
            "border-radius": tokens.radius.lg,
            padding: tokens.space.lg,
            display: "grid",
            gap: tokens.space.md
          }}
        >
          <header style={{ display: "grid", gap: "4px" }}>
            <h2 style={{ margin: 0, "font-size": "1.05rem" }}>فهرست امروز</h2>
            <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.85rem", "line-height": "1.8" }}>
              هر تغییر اول روی همین دستگاه ذخیره می‌شود؛ بی‌نیاز از اینترنت.
            </p>
          </header>

          <form onSubmit={(event) => void addItem(event)} style={{ display: "flex", gap: tokens.space.sm }}>
            <TextInput
              aria-label="کار تازه"
              placeholder="یک کار تازه…"
              value={draft()}
              onInput={(event) => updateDraft(event.currentTarget.value)}
              disabled={local.store() === undefined}
            />
            <Button type="submit" disabled={local.store() === undefined || addBusy() || draft().trim() === ""}>
              افزودن
            </Button>
          </form>

          <Show
            when={sorted().length > 0}
            fallback={
              <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.9rem" }}>
                هنوز کاری برای امروز ثبت نشده است.
              </p>
            }
          >
            <ul style={{ "list-style": "none", margin: 0, padding: 0, display: "grid", gap: "2px" }}>
              <For each={sorted()}>
                {(row) => (
                  <li
                    style={{
                      display: "flex",
                      "align-items": "center",
                      gap: tokens.space.sm,
                      padding: `${tokens.space.sm} 0`,
                      "border-bottom": `1px solid ${tokens.color.line}`
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checkedOf(row)}
                      aria-label={titleOf(row)}
                      onChange={() => void toggleItem(row)}
                      style={{ width: "18px", height: "18px", "accent-color": tokens.color.brand }}
                    />
                    <span
                      style={{
                        "line-height": "1.8",
                        "text-decoration": checkedOf(row) ? "line-through" : "none",
                        color: checkedOf(row) ? tokens.color.inkSoft : tokens.color.ink
                      }}
                    >
                      {titleOf(row)}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <Show when={!local.canSync() && local.pending() > 0}>
            <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.78rem", "line-height": "1.8" }}>
              این تغییرها در صف محلی نگه داشته شده‌اند تا همگام‌سازی فعال شود.
            </p>
          </Show>
        </section>

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
