import { createEffect, createSignal, For, Show } from "solid-js"
import { Title } from "@solidjs/meta"
import { useNavigate } from "@solidjs/router"
import { Button, tokens } from "@tali/ui"
import { AppHeader } from "../../components/app-header"
import { useLocalStore } from "../../lib/local-store"
import type { MirrorRecord } from "../../lib/local-store"
import {
  createNoteInMirror,
  filterNotesByTags,
  sortNotes,
  toNoteRow,
  type NoteRow
} from "../../lib/notes/mirror"

export default function NotesRoute() {
  return (
    <>
      <Title>یادداشت‌ها — تالی</Title>
      <NotesPage />
    </>
  )
}

const tagName = (row: MirrorRecord): string =>
  typeof row.data.name === "string" ? row.data.name : ""

const rowStyle = {
  display: "grid",
  gap: "6px",
  padding: `${tokens.space.md} 0`,
  "border-bottom": `1px solid ${tokens.color.line}`,
  "min-width": 0
} as const

/**
 * Note list (FR-NOTE-01/03): reads straight from the IndexedDB mirror, so it
 * renders offline, and every action (pin, archive, trash, tag assignment)
 * commits locally before it syncs. Pinned notes are always the first section.
 */
function NotesPage() {
  const local = useLocalStore()
  const navigate = useNavigate()

  const [notes, setNotes] = createSignal<ReadonlyArray<NoteRow>>([])
  const [tags, setTags] = createSignal<ReadonlyArray<MirrorRecord>>([])
  const [selectedTags, setSelectedTags] = createSignal<ReadonlyArray<string>>([])
  const [showArchived, setShowArchived] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  createEffect(
    () => local.store(),
    (store) => {
      if (store === undefined) {
        setNotes([])
        setTags([])
        return
      }
      let cancelled = false
      const reload = () => {
        void Promise.all([store.list("note"), store.list("tag")])
          .then(([noteRows, tagRows]) => {
            if (cancelled) return
            setNotes(noteRows.map(toNoteRow))
            setTags(tagRows)
          })
          .catch(() => {
            // The store closed (sign-out) while the read was in flight.
          })
      }
      reload()
      const unsubscribe = store.subscribe(reload)
      return () => {
        cancelled = true
        unsubscribe()
      }
    }
  )

  const active = () =>
    sortNotes(filterNotesByTags(notes().filter((note) => !note.isArchived), selectedTags()))
  const archived = () =>
    sortNotes(filterNotesByTags(notes().filter((note) => note.isArchived), selectedTags()))
  const pinned = () => active().filter((note) => note.isPinned)
  const unpinned = () => active().filter((note) => !note.isPinned)

  const toggleTag = (tagId: string) => {
    setSelectedTags((current) =>
      current.includes(tagId)
        ? current.filter((entry) => entry !== tagId)
        : [...current, tagId]
    )
  }

  const newNote = async () => {
    const store = local.store()
    if (store === undefined || busy()) return
    setBusy(true)
    try {
      const id = await createNoteInMirror(store)
      navigate(`/notes/${id}`)
    } finally {
      setBusy(false)
    }
  }

  const patch = async (note: NoteRow, values: Readonly<Record<string, unknown>>) => {
    const store = local.store()
    if (store === undefined) return
    await store.writeLocal({
      entityType: "note",
      entityId: note.id,
      op: "upsert",
      patch: values
    })
  }

  const trash = async (note: NoteRow) => {
    const store = local.store()
    if (store === undefined) return
    await store.writeLocal({ entityType: "note", entityId: note.id, op: "delete", patch: {} })
  }

  const tagLabel = (tagId: string): string => {
    const tag = tags().find((row) => row.entityId === tagId)
    return tag === undefined ? "" : tagName(tag)
  }

  const NoteActions = (props: { note: NoteRow }) => (
    <div style={{ display: "flex", gap: "4px", "flex-wrap": "wrap" }}>
      <button
        type="button"
        aria-pressed={props.note.isPinned ? "true" : "false"}
        aria-label={props.note.isPinned ? "برداشتن پین" : "پین کردن"}
        onClick={() => void patch(props.note, { isPinned: !props.note.isPinned })}
        style={actionStyle(props.note.isPinned)}
      >
        {props.note.isPinned ? "★ پین" : "☆ پین"}
      </button>
      <button
        type="button"
        aria-label={props.note.isArchived ? "بازگردانی از آرشیو" : "آرشیو کردن"}
        onClick={() => void patch(props.note, { isArchived: !props.note.isArchived })}
        style={actionStyle(false)}
      >
        {props.note.isArchived ? "بازگردانی" : "آرشیو"}
      </button>
      <button
        type="button"
        aria-label="انتقال به سطل زباله"
        onClick={() => void trash(props.note)}
        style={actionStyle(false)}
      >
        حذف
      </button>
    </div>
  )

  const NoteItem = (props: { note: NoteRow }) => (
    <li style={rowStyle}>
      <div style={{ display: "flex", gap: tokens.space.sm, "align-items": "baseline", "flex-wrap": "wrap" }}>
        <button
          type="button"
          onClick={() => navigate(`/notes/${props.note.id}`)}
          style={{
            all: "unset",
            cursor: "pointer",
            "font-weight": props.note.isPinned ? 700 : 500,
            color: tokens.color.ink,
            "overflow-wrap": "anywhere",
            "min-width": 0
          }}
        >
          {props.note.title}
        </button>
        <Show when={props.note.tagIds.length > 0}>
          <span style={{ display: "flex", gap: "4px", "flex-wrap": "wrap" }}>
            <For each={props.note.tagIds}>
              {(tagId) => (
                <span style={chipStyle(false, true)}>{tagLabel(tagId)}</span>
              )}
            </For>
          </span>
        </Show>
      </div>
      <Show when={props.note.excerpt !== ""}>
        <p
          style={{
            margin: 0,
            color: tokens.color.inkSoft,
            "font-size": "0.88rem",
            "line-height": "1.8",
            "overflow-wrap": "anywhere"
          }}
        >
          {props.note.excerpt}
        </p>
      </Show>
      <NoteActions note={props.note} />
    </li>
  )

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
        <header style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: tokens.space.sm, "flex-wrap": "wrap" }}>
          <h1 style={{ margin: 0, "font-size": "1.5rem" }}>یادداشت‌ها</h1>
          <div style={{ display: "flex", gap: tokens.space.sm, "flex-wrap": "wrap" }}>
            <Button type="button" onClick={() => void newNote()} disabled={busy() || local.store() === undefined}>
              یادداشت تازه
            </Button>
            <Button variant="ghost" type="button" onClick={() => navigate("/notes/trash")}>
              سطل زباله
            </Button>
          </div>
        </header>

        <Show when={!local.online()}>
          <p role="status" style={hintStyle}>
            آفلاین هستید؛ همه‌ی تغییرها روی همین دستگاه ذخیره می‌شوند و بعد همگام می‌شوند.
          </p>
        </Show>

        <Show when={tags().length > 0}>
          <section aria-label="فیلتر برچسب" style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
            <For each={tags()}>
              {(tag) => (
                <button
                  type="button"
                  aria-pressed={selectedTags().includes(tag.entityId) ? "true" : "false"}
                  onClick={() => toggleTag(tag.entityId)}
                  style={chipStyle(selectedTags().includes(tag.entityId), false)}
                >
                  {tagName(tag)}
                </button>
              )}
            </For>
          </section>
        </Show>

        <Show
          when={notes().length > 0}
          fallback={
            <section style={cardStyle}>
              <p style={{ margin: 0, "line-height": "2" }}>هنوز یادداشتی ندارید.</p>
              <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.9rem" }}>
                از هر صفحه با دکمه‌ی «یادداشت تازه» یا Alt+N شروع کنید؛ همان لحظه باز می‌شود.
              </p>
            </section>
          }
        >
          <Show when={pinned().length > 0}>
            <section aria-label="یادداشت‌های پین‌شده" style={cardStyle}>
              <h2 style={{ margin: 0, "font-size": "1.05rem" }}>پین‌شده</h2>
              <ul style={{ "list-style": "none", margin: 0, padding: 0 }}>
                <For each={pinned()}>{(note) => <NoteItem note={note} />}</For>
              </ul>
            </section>
          </Show>

          <section aria-label="همه‌ی یادداشت‌ها" style={cardStyle}>
            <h2 style={{ margin: 0, "font-size": "1.05rem" }}>یادداشت‌ها</h2>
            <Show
              when={unpinned().length > 0}
              fallback={
                <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.9rem" }}>
                  یادداشت دیگری نیست.
                </p>
              }
            >
              <ul style={{ "list-style": "none", margin: 0, padding: 0 }}>
                <For each={unpinned()}>{(note) => <NoteItem note={note} />}</For>
              </ul>
            </Show>
          </section>

          <section aria-label="آرشیو" style={cardStyle}>
            <button
              type="button"
              aria-expanded={showArchived() ? "true" : "false"}
              onClick={() => setShowArchived(!showArchived())}
              style={actionStyle(showArchived())}
            >
              آرشیو ({archived().length})
            </button>
            <Show when={showArchived()}>
              <Show
                when={archived().length > 0}
                fallback={
                  <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.9rem" }}>
                    آرشیو خالی است.
                  </p>
                }
              >
                <ul style={{ "list-style": "none", margin: 0, padding: 0 }}>
                  <For each={archived()}>{(note) => <NoteItem note={note} />}</For>
                </ul>
              </Show>
            </Show>
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

const hintStyle = {
  margin: 0,
  padding: "10px 12px",
  "border-radius": tokens.radius.md,
  background: "#eef4ff",
  color: tokens.color.inkSoft,
  "font-size": "0.85rem",
  "line-height": "1.8"
} as const

const actionStyle = (active: boolean) => ({
  "font-family": tokens.font.sans,
  "font-size": "0.8rem",
  padding: "4px 10px",
  "border-radius": "999px",
  border: `1px solid ${active ? tokens.color.brand : tokens.color.line}`,
  background: active ? "#eaf0ff" : tokens.color.surface,
  color: active ? tokens.color.brand : tokens.color.inkSoft,
  cursor: "pointer"
})

const chipStyle = (active: boolean, small: boolean) => ({
  "font-family": tokens.font.sans,
  "font-size": small ? "0.72rem" : "0.82rem",
  padding: small ? "1px 6px" : "3px 10px",
  "border-radius": "999px",
  border: `1px solid ${active ? tokens.color.brand : tokens.color.line}`,
  background: active ? tokens.color.brand : tokens.color.surface,
  color: active ? "#fff" : tokens.color.inkSoft,
  cursor: small ? "default" : "pointer"
})
