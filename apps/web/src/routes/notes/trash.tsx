import { createEffect, createSignal, For, Show } from "solid-js"
import { Title } from "@solidjs/meta"
import { useNavigate } from "@solidjs/router"
import { Button } from "@tali/ui"
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
    <div class="min-h-dvh overflow-x-clip bg-base-200 text-base-content" dir="rtl" lang="fa">
      <AppHeader active="notes" />

      <main class="page-wrap mx-auto grid max-w-3xl gap-4">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 class="m-0 text-2xl font-bold tracking-tight sm:text-3xl">سطل زباله</h1>
            <p class="mt-1 mb-0 text-sm text-base-content/55">
              یادداشت‌های حذف‌شده تا ۳۰ روز اینجا می‌مانند و بعد از آن پاک می‌شوند.
            </p>
          </div>
          <Button variant="ghost" type="button" onClick={() => navigate("/notes")}>
            بازگشت به یادداشت‌ها
          </Button>
        </header>

        <Show when={error()}>
          <p role="alert" class="alert alert-error m-0 py-2.5 text-sm leading-8">
            {error()}
          </p>
        </Show>

        <Show
          when={rows().length > 0}
          fallback={
            <section class="panel p-6">
              <p class="m-0 text-base-content/55">سطل زباله خالی است.</p>
            </section>
          }
        >
          <section class="panel p-4 sm:p-5">
            <ul class="m-0 list-none divide-y divide-base-300 p-0">
              <For each={rows()}>
                {(row) => (
                  <li class="grid min-w-0 gap-1.5 py-4">
                    <strong class="break-words">{row.title}</strong>
                    <Show when={row.excerpt !== ""}>
                      <span class="break-words text-sm leading-7 text-base-content/55">
                        {row.excerpt}
                      </span>
                    </Show>
                    <div>
                      <Button
                        type="button"
                        size="sm"
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
