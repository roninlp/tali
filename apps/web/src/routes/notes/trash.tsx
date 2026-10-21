import { createEffect, createSignal, For, Show } from "solid-js"
import { Title } from "@solidjs/meta"
import { useNavigate } from "@solidjs/router"
import { Button, tokens } from "@tali/ui"
import { uuidV7 } from "@tali/domain"
import { AppHeader } from "../../components/app-header"
import { api } from "../../lib/rpc"
import { useLocalStore } from "../../lib/local-store"
import { noteToServerRow, toNoteRow, type NoteRow } from "../../lib/notes/mirror"

export default function NotesTrashRoute() {
  return (
    <>
      <Title>سطل زباله — تالی</Title>
      <TrashPage />
    </>
  )
}

/**
 * Trash (FR-NOTE-03). Deleted notes are soft-deleted tombstones in the mirror
 * and stay restorable for 30 days.
 *
 * Restore goes through `RestoreNote` rather than a queued local upsert: the
 * sync protocol's tombstone-wins rule (#34) means an offline upsert can never
 * resurrect a row, so restore needs the server. We flush the outbox first so a
 * still-queued delete cannot land after the restore.
 */
function TrashPage() {
  const local = useLocalStore()
  const navigate = useNavigate()

  const [rows, setRows] = createSignal<ReadonlyArray<NoteRow>>([])
  const [busyId, setBusyId] = createSignal<string>()
  const [error, setError] = createSignal<string>()

  createEffect(
    () => local.store(),
    (store) => {
      if (store === undefined) {
        setRows([])
        return
      }
      let cancelled = false
      const reload = () => {
        void store
          .listTrashed("note")
          .then((records) => {
            if (!cancelled) setRows(records.map(toNoteRow))
          })
          .catch(() => undefined)
      }
      reload()
      const unsubscribe = store.subscribe(reload)
      return () => {
        cancelled = true
        unsubscribe()
      }
    }
  )

  const restore = async (row: NoteRow) => {
    const store = local.store()
    if (store === undefined || busyId() !== undefined) return
    setError(undefined)
    if (!local.online()) {
      setError("برای بازگرداندن یادداشت به اینترنت وصل شوید؛ متن روی دستگاه محفوظ است.")
      return
    }
    setBusyId(row.id)
    try {
      await local.syncNow()
      if (await store.hasPending("note", row.id)) {
        // The delete is still queued; restoring now could be undone by the
        // push that follows. Ask for one more sync instead of racing it.
        setError("همگام‌سازی در جریان است؛ چند لحظه بعد دوباره تلاش کنید.")
        return
      }
      const note = await api.restoreNote(row.id, uuidV7())
      await store.mergeServer([noteToServerRow(note)])
    } catch {
      setError("بازگردانی انجام نشد. اتصال را بررسی کنید و دوباره تلاش کنید.")
    } finally {
      setBusyId(undefined)
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
        background: tokens.color.canvas,
        "overflow-x": "clip"
      }}
    >
      <AppHeader active="notes" />

      <main
        style={{
          display: "grid",
          gap: tokens.space.md,
          "max-width": "720px",
          "box-sizing": "border-box",
          width: "100%",
          margin: "0 auto",
          padding: "clamp(16px, 3vw, 28px) 16px 32px"
        }}
      >
        <header style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: tokens.space.sm, "flex-wrap": "wrap" }}>
          <h1 style={{ margin: 0, "font-size": "1.35rem", "letter-spacing": "-0.02em" }}>سطل زباله</h1>
          <Button variant="ghost" type="button" onClick={() => navigate("/notes")}>
            بازگشت به یادداشت‌ها
          </Button>
        </header>

        <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.88rem", "line-height": "1.9" }}>
          یادداشت‌های حذف‌شده تا ۳۰ روز اینجا می‌مانند و بعد از آن پاک می‌شوند.
        </p>

        <Show when={error()}>
          <p
            role="alert"
            style={{
              margin: 0,
              padding: "10px 12px",
              "border-radius": tokens.radius.md,
              background: "#fdecef",
              color: "#9f1239",
              "font-size": "0.88rem",
              "line-height": "1.9"
            }}
          >
            {error()}
          </p>
        </Show>

        <Show
          when={rows().length > 0}
          fallback={
            <section style={cardStyle}>
              <p style={{ margin: 0 }}>سطل زباله خالی است.</p>
            </section>
          }
        >
          <section style={cardStyle}>
            <ul style={{ "list-style": "none", margin: 0, padding: 0 }}>
              <For each={rows()}>
                {(row) => (
                  <li
                    style={{
                      display: "grid",
                      gap: "6px",
                      padding: `${tokens.space.md} 0`,
                      "border-bottom": `1px solid ${tokens.color.line}`,
                      "min-width": 0
                    }}
                  >
                    <strong style={{ "overflow-wrap": "anywhere" }}>{row.title}</strong>
                    <Show when={row.excerpt !== ""}>
                      <span
                        style={{
                          color: tokens.color.inkSoft,
                          "font-size": "0.88rem",
                          "line-height": "1.8",
                          "overflow-wrap": "anywhere"
                        }}
                      >
                        {row.excerpt}
                      </span>
                    </Show>
                    <div>
                      <Button
                        type="button"
                        disabled={busyId() !== undefined}
                        onClick={() => void restore(row)}
                      >
                        {busyId() === row.id ? "در حال بازگردانی…" : "بازگردانی"}
                      </Button>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </main>
    </div>
  )
}

const cardStyle = {
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.line}`,
  "border-radius": tokens.radius.lg,
  padding: tokens.space.lg,
  display: "grid",
  gap: tokens.space.sm,
  "min-width": 0
} as const
