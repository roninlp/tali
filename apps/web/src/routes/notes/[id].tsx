import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { Title } from "@solidjs/meta"
import { useNavigate, useParams } from "@solidjs/router"
import { Button } from "@tali/ui"
import { uuidV7 } from "@tali/domain"
import { AppHeader } from "../../components/app-header"
import { TextInput } from "../../components/form"
import { Icon } from "../../components/icons"
import { coalesceMicrotask } from "../../lib/coalesce"
import { api } from "../../lib/rpc"
import { useLocalStore } from "../../lib/local-store"
import type { MirrorRecord } from "../../lib/local-store"
import {
  noteDraftKey,
  parseNoteDraft,
  reconcileDraft,
  serializeNoteDraft
} from "../../lib/notes/draft"
import { noteTextFromData } from "../../lib/notes/body"
import { noteToServerRow, toNoteRow } from "../../lib/notes/mirror"
import { createNoteSaver, type NoteSaver } from "../../lib/notes/saver"
import { syncFailureMessage } from "../../lib/sync-copy"

export default function NoteEditorRoute() {
  return (
    <>
      <Title>یادداشت — تالی</Title>
      <NoteEditor />
    </>
  )
}

type LoadState = "loading" | "ready" | "missing"
type SaveState = "idle" | "saving" | "saved" | "error"

const DRAFT_DEBOUNCE_MS = 120
const AUTOSAVE_DEBOUNCE_MS = 700

/**
 * The note editor (FR-NOTE-01/03).
 *
 * - Quick create lands here with the note already in the mirror.
 * - Every keystroke updates a crash-safe draft (120 ms) and schedules an
 *   autosave (700 ms). Autosave writes the mirror + outbox transaction, so it
 *   works offline; the sync engine carries it to the server with a version
 *   anchor, and the server rejects stale text instead of clobbering it.
 * - `pagehide`/`visibilitychange` flush both, covering a sudden close.
 * - Reopening reconciles the draft against the mirror's server version: newer
 *   server text wins unless this device still has a queued edit.
 */
function NoteEditor() {
  const params = useParams<{ id: string }>()
  const local = useLocalStore()
  const navigate = useNavigate()

  const [loadState, setLoadState] = createSignal<LoadState>("loading")
  const [saveState, setSaveState] = createSignal<SaveState>("idle")
  const [loadHint, setLoadHint] = createSignal<string>()
  const [actionError, setActionError] = createSignal<string>()

  const [title, setTitle] = createSignal("")
  const [text, setText] = createSignal("")
  const [baseVersion, setBaseVersion] = createSignal(0)
  const [tagIds, setTagIds] = createSignal<ReadonlyArray<string>>([])
  const [isPinned, setIsPinned] = createSignal(false)
  const [isArchived, setIsArchived] = createSignal(false)
  const [isTrashed, setIsTrashed] = createSignal(false)
  const [tags, setTags] = createSignal<ReadonlyArray<MirrorRecord>>([])
  const [busy, setBusy] = createSignal(false)
  const [retrying, setRetrying] = createSignal(false)
  const [syncError, setSyncError] = createSignal<MirrorRecord["syncError"]>()

  let saver: NoteSaver | undefined
  let unsubscribe: (() => void) | undefined
  let bodyRef: HTMLTextAreaElement | undefined
  let draftTimer: ReturnType<typeof setTimeout> | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * The text of the most recent autosave request (not yet necessarily acked).
   * A draft typed while that save was in flight extends this text, so it is
   * the right `baseText` for reopen reconciliation.
   */
  let lastSaveRequest: string | undefined
  /** The note id currently loaded into the editor (for param-change flushes). */
  let loadedId: string | undefined
  let generation = 0
  let suppressSave = false

  const noteId = () => params.id
  const tagLabel = (tagId: string): string => {
    const tag = tags().find((row) => row.entityId === tagId)
    return tag !== undefined && typeof tag.data.name === "string" ? tag.data.name : ""
  }

  const writeDraftNow = () => {
    const store = local.store()
    if (store === undefined || loadState() !== "ready") return
    const key = noteDraftKey(noteId())
    const value = text()
    const savedText = saver?.lastSaved().text
    const baseText = lastSaveRequest ?? savedText
    // Nothing typed beyond the durable text: any stored draft is stale.
    if (savedText !== undefined && value === savedText) {
      void store.clearDraft(key).catch(() => undefined)
      return
    }
    // Persist even an empty value: clearing the note is a real edit, and a
    // sudden close before the next autosave must not resurrect the old text.
    void store
      .saveDraft(
        key,
        serializeNoteDraft({
          version: baseVersion(),
          text: value,
          ...(baseText === undefined ? {} : { baseText }),
          savedAt: new Date().toISOString()
        })
      )
      .catch(() => undefined)
  }

  const runSave = async () => {
    if (saver === undefined || loadState() !== "ready" || suppressSave) return
    setSaveState("saving")
    const textNow = text()
    lastSaveRequest = textNow
    try {
      await saver.save({ title: title(), text: textNow })
      setSaveState("saved")
    } catch {
      // The request did not commit: the durable text is still the old one.
      lastSaveRequest = saver.lastSaved().text
      setSaveState("error")
    }
  }

  /**
   * Save the current text before a screen action leaves the editor (archive,
   * trash). Returns false when the mirror write failed, so the caller can stay
   * put instead of discarding the keystrokes buffered by the 700 ms debounce.
   */
  const flushBeforeLeaving = async (): Promise<boolean> => {
    clearTimeout(draftTimer)
    clearTimeout(saveTimer)
    if (saver === undefined || loadState() !== "ready") return true
    setSaveState("saving")
    const textNow = text()
    lastSaveRequest = textNow
    try {
      await saver.save({ title: title(), text: textNow })
      setSaveState("saved")
      return true
    } catch {
      // The mirror still holds the previous text; anchor the crash draft to it.
      lastSaveRequest = saver.lastSaved().text
      setSaveState("error")
      writeDraftNow()
      setActionError("ذخیره‌ی متن انجام نشد؛ دوباره تلاش کنید.")
      return false
    }
  }

  const scheduleSave = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void runSave(), AUTOSAVE_DEBOUNCE_MS)
  }

  const scheduleDraft = () => {
    clearTimeout(draftTimer)
    draftTimer = setTimeout(writeDraftNow, DRAFT_DEBOUNCE_MS)
  }

  const onTextInput = (value: string) => {
    setText(value)
    scheduleDraft()
    scheduleSave()
  }

  /**
   * The row state this editor last refreshed from. Unrelated commits (another
   * note, a tag, a pull page) still notify; without this they would also
   * re-read the draft and reschedule it.
   */
  let refreshedVersion: number | undefined
  let refreshedText: string | undefined

  /**
   * Both facts the editor needs from the mirror — the draft's version anchor
   * and the rejection marker — live on the same row, and every keystroke's
   * commit notifies. Read once per notification burst instead of twice per
   * notification.
   */
  const refreshFromStore = async () => {
    const store = local.store()
    if (store === undefined || loadState() !== "ready") return
    const ticket = generation
    const id = noteId()
    const record = await store.get("note", id)
    if (ticket !== generation || record === undefined) return
    setSyncError(record.syncError)
    if (saver === undefined) return
    const rowText = noteTextFromData(record.data)
    if (rowText !== saver.lastSaved().text) return
    if (record.version === refreshedVersion && rowText === refreshedText) return
    refreshedVersion = record.version
    refreshedText = rowText
    setBaseVersion(record.version)
    const draft = parseNoteDraft(await store.readDraft(noteDraftKey(id)))
    if (draft === undefined) return
    if (text() === saver.lastSaved().text) {
      // The mirror is already durable for this exact text.
      await store.clearDraft(noteDraftKey(id)).catch(() => undefined)
    } else {
      // Re-anchor the still-unsaved text to the acknowledged version.
      scheduleDraft()
    }
  }

  // The coalescer runs this outside Solid's tracking; it reads the latest
  // signals once per notification burst.
  // oxlint-disable-next-line solid/reactivity
  const scheduleRefresh = coalesceMicrotask(() => {
    void refreshFromStore().catch(() => undefined)
  })

  const loadTags = async () => {
    const store = local.store()
    if (store === undefined) return
    try {
      setTags(await store.list("tag"))
    } catch {
      // Tags are a filter convenience; a read failure must not block editing.
    }
  }

  /**
   * Requeue this note after a rejection without replaying the acked entry.
   * The store writes a fresh upsert from the mirror's current data and version
   * anchor, so the normal sync path can try again; if the server refuses it
   * again the marker comes back from `ack`.
   */
  const retrySync = async () => {
    const store = local.store()
    if (store === undefined || retrying()) return
    setRetrying(true)
    setActionError(undefined)
    try {
      const retried = await store.retryFailed("note", noteId())
      if (retried === undefined) {
        setActionError("این یادداشت دیگر روی این دستگاه نیست.")
        return
      }
      setSyncError(undefined)
      setBaseVersion(retried.version)
      void local.syncNow()
    } catch {
      setActionError("تلاش دوباره انجام نشد. اتصال را بررسی کنید.")
    } finally {
      setRetrying(false)
    }
  }

  const hydrateFromServer = async (id: string): Promise<boolean> => {
    const store = local.store()
    if (store === undefined || !local.online()) return false
    try {
      const note = await api.getNote(id)
      await store.mergeServer([noteToServerRow(note)])
      return true
    } catch {
      return false
    }
  }

  // Load the note from the mirror first; only an unknown note falls back to
  // the server, so the editor renders offline.
  createEffect(
    () => ({ store: local.store(), id: params.id }),
    ({ store, id }) => {
      if (store === undefined || id === undefined) return
      // A param change (e.g. Alt+N while typing) reuses this component rather
      // than unmounting it, so `onCleanup` does not run. Flush the note we are
      // leaving under its own id before the editor state is replaced.
      if (loadedId !== undefined && loadedId !== id && saver !== undefined && !suppressSave) {
        const previousSaver = saver
        const previousId = loadedId
        const previousText = text()
        const previousTitle = title()
        const previousVersion = baseVersion()
        const previousBase = previousSaver.lastSaved().text
        void (async () => {
          if (previousText !== previousBase) {
            try {
              await store.saveDraft(
                noteDraftKey(previousId),
                serializeNoteDraft({
                  version: previousVersion,
                  text: previousText,
                  baseText: previousBase,
                  savedAt: new Date().toISOString()
                })
              )
            } catch {
              // The save below is still the durable path.
            }
          }
          try {
            await previousSaver.save({ title: previousTitle, text: previousText })
          } catch {
            // The draft above keeps the text for the next open.
          }
        })()
      }
      clearTimeout(draftTimer)
      clearTimeout(saveTimer)
      saver = undefined
      lastSaveRequest = undefined
      suppressSave = false
      refreshedVersion = undefined
      refreshedText = undefined
      const ticket = ++generation
      setLoadState("loading")
      setLoadHint(undefined)
      setActionError(undefined)
      setSyncError(undefined)

      void (async () => {
        let record = await store.get("note", id)
        if (record === undefined) {
          const hydrated = await hydrateFromServer(id)
          if (hydrated) record = await store.get("note", id)
        }
        if (ticket !== generation) return
        if (record === undefined) {
          setLoadState("missing")
          setLoadHint(
            local.online()
              ? "این یادداشت پیدا نشد؛ شاید حذف شده باشد."
              : "این یادداشت روی این دستگاه نیست و اتصال هم برقرار نیست."
          )
          return
        }

        const row = toNoteRow(record)
        const serverText = row.text
        const draft = parseNoteDraft(await store.readDraft(noteDraftKey(id)))
        const hasPending = await store.hasPending("note", id)
        if (ticket !== generation) return
        const decision = reconcileDraft({
          draft,
          serverVersion: record.version,
          serverText,
          hasPending
        })

        setBaseVersion(record.version)
        setTitle(typeof record.data.title === "string" ? record.data.title : "")
        setText(decision.apply ? decision.text : serverText)
        setTagIds(row.tagIds)
        setIsPinned(row.isPinned)
        setIsArchived(row.isArchived)
        setIsTrashed(record.deletedAt !== null)
        setSyncError(record.syncError)
        refreshedVersion = record.version
        refreshedText = serverText
        loadedId = id
        setLoadState("ready")
        // Open-to-type: the caret is already in the body, no extra tap.
        queueMicrotask(() => bodyRef?.focus())
        void loadTags()
        unsubscribe?.()
        // An external store event, not a tracked reactive scope; the coalescer
        // keeps a keystroke burst to one refresh.
        unsubscribe = store.subscribe(scheduleRefresh)

        if (decision.apply) {
          // Keep the rescued draft on the same autosave path immediately; it
          // may only have existed in the drafts store until now.
          saver = createNoteSaver(store, id, {
            title: typeof record.data.title === "string" ? record.data.title : "",
            text: serverText
          })
          scheduleDraft()
          scheduleSave()
        } else {
          saver = createNoteSaver(store, id, {
            title: typeof record.data.title === "string" ? record.data.title : "",
            text: serverText
          })
          if (
            decision.reason === "server-newer" ||
            decision.reason === "empty" ||
            decision.reason === "unchanged"
          ) {
            // Redundant (text already durable), legacy-empty, or beaten by
            // newer server text: the draft has been consumed and must not
            // resurface on the next open.
            void store.clearDraft(noteDraftKey(id)).catch(() => undefined)
          }
        }
      })().catch(() => {
        if (ticket !== generation) return
        setLoadState("missing")
        setLoadHint("خواندن یادداشت ممکن نشد.")
      })

      return () => {
        generation += 1
        unsubscribe?.()
        unsubscribe = undefined
      }
    }
  )

  const patch = async (values: Readonly<Record<string, unknown>>) => {
    const store = local.store()
    if (store === undefined) return
    await store.writeLocal({
      entityType: "note",
      entityId: noteId(),
      op: "upsert",
      patch: values
    })
  }

  // Title edits are discrete, so they commit immediately (no title loss). The
  // saver baseline follows the committed title, otherwise the next body
  // autosave would re-write an unchanged title and mint a duplicate version.
  const onTitleInput = (value: string) => {
    setTitle(value)
    const saverAtInput = saver
    void patch({ title: value })
      .then(() => {
        // Ignore a patch that resolves after navigating to another note.
        if (saver === saverAtInput && title() === value) saverAtInput?.markTitleSaved(value)
      })
      .catch(() => undefined)
  }

  const toggleTag = async (tagId: string) => {
    const next = tagIds().includes(tagId)
      ? tagIds().filter((entry) => entry !== tagId)
      : [...tagIds(), tagId]
    setTagIds(next)
    await patch({ tagIds: next })
  }

  const togglePinned = async () => {
    const next = !isPinned()
    setIsPinned(next)
    await patch({ isPinned: next })
  }

  const archive = async () => {
    if (isArchived()) {
      // Unarchive in place: the note becomes active again without leaving.
      setIsArchived(false)
      await patch({ isArchived: false })
      return
    }
    // Archive is not delete: flush the debounced text first, or the last
    // keystrokes would vanish from the archived note.
    if (!(await flushBeforeLeaving())) return
    suppressSave = true
    await patch({ isArchived: true })
    navigate("/notes")
  }

  const trash = async () => {
    // The trashed note stays restorable for 30 days, so the current text must
    // reach the mirror before the tombstone is written.
    if (!(await flushBeforeLeaving())) return
    suppressSave = true
    const store = local.store()
    if (store === undefined) return
    await store.writeLocal({ entityType: "note", entityId: noteId(), op: "delete", patch: {} })
    navigate("/notes")
  }

  const restore = async () => {
    const store = local.store()
    if (store === undefined || busy()) return
    setActionError(undefined)
    if (!local.online()) {
      setActionError("برای بازگرداندن یادداشت به اینترنت وصل شوید؛ متن روی دستگاه محفوظ است.")
      return
    }
    setBusy(true)
    try {
      await local.syncNow()
      if (await store.hasPending("note", noteId())) {
        setActionError("همگام‌سازی در جریان است؛ چند لحظه بعد دوباره تلاش کنید.")
        return
      }
      const note = await api.restoreNote(noteId(), uuidV7())
      await store.mergeServer([noteToServerRow(note)])
      setIsTrashed(false)
    } catch {
      setActionError("بازگردانی انجام نشد. اتصال را بررسی کنید.")
    } finally {
      setBusy(false)
    }
  }

  // Sudden close: flush both the draft and the mirror write.
  createEffect(
    () => null,
    () => {
      if (typeof window === "undefined") return
      const flush = () => {
        if (suppressSave) return
        writeDraftNow()
        void runSave()
      }
      const onHidden = () => {
        if (document.visibilityState === "hidden") flush()
      }
      window.addEventListener("pagehide", flush)
      document.addEventListener("visibilitychange", onHidden)
      return () => {
        window.removeEventListener("pagehide", flush)
        document.removeEventListener("visibilitychange", onHidden)
      }
    }
  )

  onCleanup(() => {
    unsubscribe?.()
    unsubscribe = undefined
    clearTimeout(draftTimer)
    clearTimeout(saveTimer)
    if (!suppressSave) {
      writeDraftNow()
      void runSave()
    }
  })

  const statusText = () => {
    if (saveState() === "error") return "ذخیره نشد؛ دوباره تلاش می‌شود."
    if (saveState() === "saving") return "در حال ذخیره…"
    if (syncError() !== undefined) return "ذخیره نشد؛ روی سرور اعمال نشد"
    if (local.pending() > 0) return "ذخیره شد؛ در انتظار همگام‌سازی"
    return "ذخیره شد"
  }

  return (
    <div class="min-h-dvh overflow-x-clip bg-base-200 text-base-content" dir="rtl" lang="fa">
      <AppHeader active="notes" />

      <main class="page-wrap mx-auto grid max-w-3xl gap-4">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" type="button" class="gap-1.5" onClick={() => navigate("/notes")}>
            <span aria-hidden="true">→</span>
            یادداشت‌ها
          </Button>
          <span
            role="status"
            aria-live="polite"
            class={
              saveState() === "error" || syncError() !== undefined
                ? "badge badge-error badge-sm h-7 gap-1.5"
                : "badge badge-ghost badge-sm h-7 gap-1.5"
            }
          >
            <span
              aria-hidden="true"
              class={
                saveState() === "saving"
                  ? "loading loading-spinner loading-xs"
                  : "size-1.5 rounded-full bg-current opacity-60"
              }
            />
            {loadState() === "ready" ? statusText() : ""}
          </span>
        </header>

        <Show when={loadState() === "missing"}>
          <section class="panel grid gap-3 p-5">
            <p class="m-0">{loadHint()}</p>
            <div>
              <Button variant="ghost" type="button" onClick={() => navigate("/notes")}>
                بازگشت
              </Button>
            </div>
          </section>
        </Show>

        <Show when={loadState() === "loading"}>
          <p class="m-0 flex items-center gap-2 text-base-content/55">
            <span class="loading loading-spinner loading-sm" />
            در حال باز کردن یادداشت…
          </p>
        </Show>

        <Show when={loadState() === "ready"}>
          <Show when={isTrashed()}>
            <section class="alert alert-warning items-start">
              <div class="grid gap-2">
                <p class="m-0 font-medium">این یادداشت در سطل زباله است.</p>
                <div class="flex flex-wrap gap-2">
                  <Button type="button" disabled={busy()} onClick={() => void restore()}>
                    {busy() ? "در حال بازگردانی…" : "بازگردانی"}
                  </Button>
                  <Button variant="ghost" type="button" onClick={() => navigate("/notes/trash")}>
                    سطل زباله
                  </Button>
                </div>
              </div>
            </section>
          </Show>

          <Show when={syncError()}>
            {(failure) => (
              <section role="alert" class="alert alert-error items-start">
                <div class="grid gap-2">
                  <p class="m-0 leading-8">{syncFailureMessage(failure().code)}</p>
                  <p class="m-0 text-[0.82rem] opacity-80">
                    این یادداشت فعلاً فقط روی این دستگاه ذخیره شده است.
                  </p>
                  <div>
                    <Button type="button" disabled={retrying()} onClick={() => void retrySync()}>
                      {retrying() ? "در حال تلاش…" : "تلاش دوباره"}
                    </Button>
                  </div>
                </div>
              </section>
            )}
          </Show>

          <Show when={actionError()}>
            <p role="alert" class="alert alert-error m-0 py-2.5 text-sm leading-8">
              {actionError()}
            </p>
          </Show>

          <section class="panel grid gap-4 p-4 sm:p-6">
            <label for="note-title" class="grid gap-1.5">
              <span class="text-[0.82rem] text-base-content/55">عنوان</span>
              <TextInput
                id="note-title"
                aria-label="عنوان یادداشت"
                class="input-lg font-bold"
                placeholder="بی‌عنوان"
                value={title()}
                onInput={(event) => onTitleInput(event.currentTarget.value)}
                disabled={isTrashed()}
              />
            </label>

            <Show when={tags().length > 0}>
              <div aria-label="برچسب‌ها" class="flex flex-wrap gap-1.5">
                <For each={tags()}>
                  {(tag) => (
                    <button
                      type="button"
                      aria-pressed={tagIds().includes(tag.entityId) ? "true" : "false"}
                      disabled={isTrashed()}
                      onClick={() => void toggleTag(tag.entityId)}
                      class={
                        tagIds().includes(tag.entityId)
                          ? "badge badge-primary cursor-pointer"
                          : "badge badge-ghost cursor-pointer"
                      }
                    >
                      {tagLabel(tag.entityId)}
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <label for="note-body" class="grid gap-1.5">
              <span class="text-[0.82rem] text-base-content/55">
                متن (ساده یا مارک‌داون)
              </span>
              <textarea
                id="note-body"
                ref={(element) => (bodyRef = element)}
                aria-label="متن یادداشت"
                placeholder="از همین‌جا شروع کنید…"
                value={text()}
                readonly={isTrashed()}
                onInput={(event) => onTextInput(event.currentTarget.value)}
                rows={14}
                class="textarea textarea-bordered min-h-[45dvh] w-full resize-y p-4 text-base leading-8"
              />
            </label>

            <div class="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={isPinned() ? "primary" : "ghost"}
                class="gap-1.5 rounded-full"
                aria-pressed={isPinned() ? "true" : "false"}
                onClick={() => void togglePinned()}
                disabled={isTrashed()}
              >
                <Icon name="pin" class="size-4" />
                {isPinned() ? "پین‌شده" : "پین کردن"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                class="gap-1.5 rounded-full"
                onClick={() => void archive()}
                disabled={isTrashed()}
              >
                <Icon name="archive" class="size-4" />
                {isArchived() ? "بازگردانی از آرشیو" : "آرشیو"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                class="me-auto gap-1.5 rounded-full text-error"
                onClick={() => void trash()}
                disabled={isTrashed()}
              >
                <Icon name="trash" class="size-4" />
                انتقال به سطل زباله
              </Button>
            </div>
          </section>
        </Show>
      </main>
    </div>
  )
}
