import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { Title } from "@solidjs/meta"
import { useNavigate, useParams } from "@solidjs/router"
import { Button, tokens } from "@tali/ui"
import { uuidV7 } from "@tali/domain"
import { AppHeader } from "../../components/app-header"
import { TextInput } from "../../components/form"
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
   * Keep the draft's version anchor honest. A sync ack moves the mirror's
   * server version forward without changing the text; the draft typed over
   * that text must move with it, or a reopen would wrongly judge it stale. A
   * remote text change (mirror text differs from what we last saved) must NOT
   * move the anchor — that is exactly the newer-server-text case we protect.
   */
  const refreshAnchor = async () => {
    const store = local.store()
    if (store === undefined || saver === undefined || loadState() !== "ready") return
    const id = noteId()
    const record = await store.get("note", id)
    if (record === undefined) return
    const rowText = noteTextFromData(record.data)
    if (rowText !== saver.lastSaved().text) return
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

  const loadTags = async () => {
    const store = local.store()
    if (store === undefined) return
    try {
      setTags(await store.list("tag"))
    } catch {
      // Tags are a filter convenience; a read failure must not block editing.
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
      const ticket = ++generation
      setLoadState("loading")
      setLoadHint(undefined)
      setActionError(undefined)

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
        loadedId = id
        setLoadState("ready")
        // Open-to-type: the caret is already in the body, no extra tap.
        queueMicrotask(() => bodyRef?.focus())
        void loadTags()
        unsubscribe?.()
        unsubscribe = store.subscribe(
          // An external store event, not a tracked reactive scope.
          // oxlint-disable-next-line solid/reactivity
          () => {
            void refreshAnchor().catch(() => undefined)
          }
        )

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
    if (local.pending() > 0) return "ذخیره شد؛ در انتظار همگام‌سازی"
    return "ذخیره شد"
  }

  return (
    <div
      dir="rtl"
      lang="fa"
      style={{
        "min-height": "100dvh",
        "font-family": tokens.font.sans,
        color: tokens.color.ink,
        background: "#f7f9fd",
        "overflow-x": "hidden"
      }}
    >
      <AppHeader active="notes" />

      <main
        style={{
          padding: tokens.space.lg,
          display: "grid",
          gap: tokens.space.md,
          "max-width": "720px",
          "box-sizing": "border-box",
          width: "100%"
        }}
      >
        <header
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "space-between",
            gap: tokens.space.sm,
            "flex-wrap": "wrap"
          }}
        >
          <Button variant="ghost" type="button" onClick={() => navigate("/notes")}>
            یادداشت‌ها
          </Button>
          <span role="status" aria-live="polite" style={{ color: tokens.color.inkSoft, "font-size": "0.82rem" }}>
            {loadState() === "ready" ? statusText() : ""}
          </span>
        </header>

        <Show when={loadState() === "missing"}>
          <section style={cardStyle}>
            <p style={{ margin: 0 }}>{loadHint()}</p>
            <div>
              <Button variant="ghost" type="button" onClick={() => navigate("/notes")}>
                بازگشت
              </Button>
            </div>
          </section>
        </Show>

        <Show when={loadState() === "loading"}>
          <p style={{ margin: 0, color: tokens.color.inkSoft }}>در حال باز کردن یادداشت…</p>
        </Show>

        <Show when={loadState() === "ready"}>
          <Show when={isTrashed()}>
            <section style={{ ...cardStyle, background: "#fff7ed", border: "1px solid #fed7aa" }}>
              <p style={{ margin: 0 }}>این یادداشت در سطل زباله است.</p>
              <div style={{ display: "flex", gap: tokens.space.sm, "flex-wrap": "wrap" }}>
                <Button type="button" disabled={busy()} onClick={() => void restore()}>
                  {busy() ? "در حال بازگردانی…" : "بازگردانی"}
                </Button>
                <Button variant="ghost" type="button" onClick={() => navigate("/notes/trash")}>
                  سطل زباله
                </Button>
              </div>
            </section>
          </Show>

          <Show when={actionError()}>
            <p role="alert" style={errorStyle}>
              {actionError()}
            </p>
          </Show>

          <section style={cardStyle}>
            <label for="note-title" style={{ display: "grid", gap: "6px" }}>
              <span style={{ "font-size": "0.82rem", color: tokens.color.inkSoft }}>عنوان</span>
              <TextInput
                id="note-title"
                aria-label="عنوان یادداشت"
                placeholder="بی‌عنوان"
                value={title()}
                onInput={(event) => onTitleInput(event.currentTarget.value)}
                disabled={isTrashed()}
              />
            </label>

            <Show when={tags().length > 0}>
              <div aria-label="برچسب‌ها" style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
                <For each={tags()}>
                  {(tag) => (
                    <button
                      type="button"
                      aria-pressed={tagIds().includes(tag.entityId) ? "true" : "false"}
                      disabled={isTrashed()}
                      onClick={() => void toggleTag(tag.entityId)}
                      style={chipStyle(tagIds().includes(tag.entityId))}
                    >
                      {tagLabel(tag.entityId)}
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <label for="note-body" style={{ display: "grid", gap: "6px" }}>
              <span style={{ "font-size": "0.82rem", color: tokens.color.inkSoft }}>
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
                style={{
                  "font-family": tokens.font.sans,
                  "font-size": "1rem",
                  "line-height": "2",
                  padding: tokens.space.md,
                  border: `1px solid ${tokens.color.line}`,
                  "border-radius": tokens.radius.md,
                  color: tokens.color.ink,
                  background: tokens.color.surface,
                  width: "100%",
                  "box-sizing": "border-box",
                  "min-height": "45dvh",
                  resize: "vertical",
                  "overflow-wrap": "anywhere",
                  "white-space": "pre-wrap"
                }}
              />
            </label>

            <div style={{ display: "flex", gap: tokens.space.sm, "flex-wrap": "wrap" }}>
              <button
                type="button"
                aria-pressed={isPinned() ? "true" : "false"}
                onClick={() => void togglePinned()}
                disabled={isTrashed()}
                style={actionStyle(isPinned())}
              >
                {isPinned() ? "★ پین‌شده" : "☆ پین کردن"}
              </button>
              <button
                type="button"
                onClick={() => void archive()}
                disabled={isTrashed()}
                style={actionStyle(isArchived())}
              >
                {isArchived() ? "بازگردانی از آرشیو" : "آرشیو"}
              </button>
              <button
                type="button"
                onClick={() => void trash()}
                disabled={isTrashed()}
                style={actionStyle(false)}
              >
                انتقال به سطل زباله
              </button>
            </div>
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
  gap: tokens.space.md,
  "min-width": 0
} as const

const errorStyle = {
  margin: 0,
  padding: "10px 12px",
  "border-radius": tokens.radius.md,
  background: "#fdecef",
  color: "#9f1239",
  "font-size": "0.88rem",
  "line-height": "1.9"
} as const

const chipStyle = (active: boolean) => ({
  "font-family": tokens.font.sans,
  "font-size": "0.82rem",
  padding: "3px 10px",
  "border-radius": "999px",
  border: `1px solid ${active ? tokens.color.brand : tokens.color.line}`,
  background: active ? tokens.color.brand : tokens.color.surface,
  color: active ? "#fff" : tokens.color.inkSoft,
  cursor: "pointer"
})

const actionStyle = (active: boolean) => ({
  "font-family": tokens.font.sans,
  "font-size": "0.85rem",
  padding: "6px 12px",
  "border-radius": "999px",
  border: `1px solid ${active ? tokens.color.brand : tokens.color.line}`,
  background: active ? "#eaf0ff" : tokens.color.surface,
  color: active ? tokens.color.brand : tokens.color.inkSoft,
  cursor: "pointer"
})
