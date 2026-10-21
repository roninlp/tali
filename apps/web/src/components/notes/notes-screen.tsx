import { createEffect, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button, tokens } from "@tali/ui"
import {
  buildVariantInsensitivePattern,
  type NoteSearchSegment
} from "@tali/domain"
import { AppHeader } from "../app-header"
import { useLocalStore } from "../../lib/local-store"
import type { MirrorRecord } from "../../lib/local-store"
import {
  createNoteInMirror,
  filterNotesByTags,
  sortNotes,
  toNoteRow,
  type NoteRow
} from "../../lib/notes/mirror"
import { searchNotes } from "../../lib/notes/search-api"
import { markMatches, excerptAroundMatch, searchNotesLocally } from "../../lib/notes/search"

const tagName = (row: MirrorRecord): string =>
  typeof row.data.name === "string" ? row.data.name : ""

/** One search result, from the server's index or from the local mirror. */
interface SearchHit {
  readonly id: string
  readonly title: string
  readonly segments: ReadonlyArray<NoteSearchSegment>
  readonly updatedAt: string
}

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
 *
 * The screen also owns the note search (ticket #41): the server's FTS5 index
 * answers the query, the local mirror answers it when the network is gone.
 */
export function NotesScreen() {
  const local = useLocalStore()
  const navigate = useNavigate()

  const [notes, setNotes] = createSignal<ReadonlyArray<NoteRow>>([])
  const [tags, setTags] = createSignal<ReadonlyArray<MirrorRecord>>([])
  const [selectedTags, setSelectedTags] = createSignal<ReadonlyArray<string>>([])
  const [showArchived, setShowArchived] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  // ── Search (ticket #41) ────────────────────────────────────────────────
  //
  // The server's FTS5 index answers the query; when the network is gone the
  // local mirror answers it instead, so the box keeps working offline. The
  // results replace the list while a query is active.
  const [query, setQuery] = createSignal("")
  const [hits, setHits] = createSignal<ReadonlyArray<SearchHit>>([])
  const [searching, setSearching] = createSignal(false)
  const [offlineSearch, setOfflineSearch] = createSignal(false)
  let searchInput: HTMLInputElement | undefined

  const trimmed = () => query().trim()

  const localHits = (text: string): ReadonlyArray<SearchHit> =>
    searchNotesLocally(notes(), text).map((hit) => ({
      id: hit.id,
      title: hit.title,
      segments: hit.segments,
      updatedAt: hit.updatedAt
    }))

  createEffect(
    () => trimmed(),
    (text) => {
      if (text === "") {
        setHits([])
        setSearching(false)
        setOfflineSearch(false)
        return
      }

      const controller = new AbortController()
      // Instant search: a short debounce keeps the request count sane while the
      // user is still typing.
      const timer = setTimeout(() => {
        void (async () => {
          setSearching(true)
          const response = await searchNotes(text, controller.signal)
          if (controller.signal.aborted) return
          setSearching(false)
          if (response.ok) {
            setOfflineSearch(false)
            setHits(
              response.value.hits.map((hit) => ({
                id: hit.id,
                title: hit.title,
                segments: hit.segments,
                updatedAt: hit.updatedAt
              }))
            )
            return
          }
          // The network is gone (or the session expired): the mirror still has
          // the notes, so search them locally.
          setOfflineSearch(true)
          setHits(localHits(text))
        })()
      }, 180)

      // The effect's cleanup: the next keystroke aborts the request in flight
      // and drops the pending timer.
      return () => {
        clearTimeout(timer)
        controller.abort()
      }
    }
  )
  // Ctrl/⌘+K focuses the search box from anywhere on the screen.
  createEffect(
    () => null,
    () => {
      if (typeof window === "undefined") return
      const onKey = (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
          event.preventDefault()
          searchInput?.focus()
          searchInput?.select()
        }
      }
      window.addEventListener("keydown", onKey)
      return () => window.removeEventListener("keydown", onKey)
    }
  )

  const clearSearch = () => {
    setQuery("")
    searchInput?.blur()
  }

  /** The title of a hit, with the query marked in it. */
  const titleSegments = (hit: SearchHit): ReadonlyArray<NoteSearchSegment> => {
    const pattern = buildVariantInsensitivePattern(trimmed())
    if (pattern === undefined) return [{ text: hit.title, match: false }]
    // The mirror has the note exactly as it was written; the server's title
    // comes from the index, which holds the folded spelling.
    const note = notes().find((candidate) => candidate.id === hit.id)
    return markMatches(note?.title ?? hit.title, pattern)
  }

  /**
   * The snippet of a hit.
   *
   * The server's snippet is built from the folded text (the index holds the
   * folded spelling, so it drops the user's half-space). When the mirror has
   * the note, the client re-marks the match in the original text instead —
   * the user's own spelling, with the match highlighted.
   */
  const snippetSegments = (hit: SearchHit): ReadonlyArray<NoteSearchSegment> => {
    const pattern = buildVariantInsensitivePattern(trimmed())
    if (pattern === undefined) return hit.segments
    const note = notes().find((candidate) => candidate.id === hit.id)
    if (note === undefined) return hit.segments
    const source = note.text !== "" ? note.text : note.title
    const excerpt = excerptAroundMatch(source, pattern)
    return excerpt.length > 0 ? excerpt : hit.segments
  }

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

  /** The segments of a snippet, with the matched runs marked. */
  const Marked = (props: { segments: ReadonlyArray<NoteSearchSegment> }) => (
    <>
      <For each={props.segments}>
        {(segment) => (
          <Show when={segment.match} fallback={<span>{segment.text}</span>}>
            <mark style={markStyle}>{segment.text}</mark>
          </Show>
        )}
      </For>
    </>
  )

  const SearchResult = (props: { hit: SearchHit }) => (
    <li style={rowStyle}>
      <button
        type="button"
        onClick={() => navigate(`/notes/${props.hit.id}`)}
        style={{
          all: "unset",
          cursor: "pointer",
          "font-weight": 500,
          color: tokens.color.ink,
          "overflow-wrap": "anywhere",
          "min-width": 0
        }}
      >
        <Marked segments={titleSegments(props.hit)} />
      </button>
      <Show when={props.hit.segments.length > 0}>
        <p
          style={{
            margin: 0,
            color: tokens.color.inkSoft,
            "font-size": "0.88rem",
            "line-height": "1.8",
            "overflow-wrap": "anywhere"
          }}
        >
          <Marked segments={snippetSegments(props.hit)} />
        </p>
      </Show>
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

        <section aria-label="جست‌وجو" style={cardStyle}>
          {/* The label wraps the input, so the field's accessible name is the
              hint text — and the query stays reachable by its label. */}
          <label
            style={{
              display: "grid",
              gap: "6px",
              "font-size": "0.85rem",
              color: tokens.color.inkSoft
            }}
          >
            <span>جست‌وجو در یادداشت‌ها (Ctrl+K)</span>
            <div style={{ display: "flex", gap: tokens.space.sm, "align-items": "center" }}>
              <input
                id="note-search"
                ref={searchInput}
                type="search"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault()
                    clearSearch()
                  }
                }}
                placeholder="مثلاً: دارو"
                autocomplete="off"
                style={{
                  flex: 1,
                  "min-width": 0,
                  "font-family": tokens.font.sans,
                  "font-size": "0.95rem",
                  padding: "8px 10px",
                  "border-radius": tokens.radius.md,
                  border: `1px solid ${tokens.color.line}`,
                  background: tokens.color.surface,
                  color: tokens.color.ink
                }}
              />
              <Show when={trimmed() !== ""}>
                <Button variant="ghost" type="button" onClick={clearSearch}>
                  پاک کردن
                </Button>
              </Show>
            </div>
          </label>
          <Show when={searching()}>
            <p role="status" style={{ ...hintStyle, "margin-top": "8px" }}>
              در حال جست‌وجو…
            </p>
          </Show>
          <Show when={offlineSearch()}>
            <p role="status" style={{ ...hintStyle, "margin-top": "8px" }}>
              جست‌وجو روی همین دستگاه انجام شد؛ نتیجه‌های سرور بعد از همگام‌سازی کامل می‌شود.
            </p>
          </Show>
        </section>

        <Show when={trimmed() !== ""}>
          <section aria-label="نتیجه‌های جست‌وجو" style={cardStyle}>
            <h2 style={{ margin: 0, "font-size": "1.05rem" }}>نتیجه‌ها</h2>
            <Show
              when={hits().length > 0}
              fallback={
                <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.9rem" }}>
                  چیزی پیدا نشد.
                </p>
              }
            >
              <ul style={{ "list-style": "none", margin: 0, padding: 0 }}>
                <For each={hits()}>{(hit) => <SearchResult hit={hit} />}</For>
              </ul>
            </Show>
          </section>
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
          when={trimmed() === "" && notes().length > 0}
          fallback={
            <Show when={trimmed() === ""}>
              <section style={cardStyle}>
                <p style={{ margin: 0, "line-height": "2" }}>هنوز یادداشتی ندارید.</p>
                <p style={{ margin: 0, color: tokens.color.inkSoft, "font-size": "0.9rem" }}>
                  از هر صفحه با دکمه‌ی «یادداشت تازه» یا Alt+N شروع کنید؛ همان لحظه باز می‌شود.
                </p>
              </section>
            </Show>
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

/** The matched run of a search result. */
const markStyle = {
  background: "#fff3bf",
  color: tokens.color.ink,
  "border-radius": "3px",
  padding: "0 2px"
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
