import { createEffect, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@tali/ui"
import {
  buildVariantInsensitivePattern,
  type NoteSearchSegment
} from "@tali/domain"
import { AppHeader } from "../app-header"
import { Icon } from "../icons"
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

const rowStyle = "grid min-w-0 gap-1.5 py-4"

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
    <div class="flex flex-wrap gap-1">
      <Button
        type="button"
        size="xs"
        variant={props.note.isPinned ? "primary" : "ghost"}
        class="gap-1 rounded-full font-normal"
        aria-pressed={props.note.isPinned ? "true" : "false"}
        aria-label={props.note.isPinned ? "برداشتن پین" : "پین کردن"}
        onClick={() => void patch(props.note, { isPinned: !props.note.isPinned })}
      >
        <Icon name="pin" class="size-3.5" />
        {props.note.isPinned ? "پین‌شده" : "پین"}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        class="gap-1 rounded-full font-normal"
        aria-label={props.note.isArchived ? "بازگردانی از آرشیو" : "آرشیو کردن"}
        onClick={() => void patch(props.note, { isArchived: !props.note.isArchived })}
      >
        <Icon name="archive" class="size-3.5" />
        {props.note.isArchived ? "بازگردانی" : "آرشیو"}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        class="gap-1 rounded-full font-normal text-error"
        aria-label="انتقال به سطل زباله"
        onClick={() => void trash(props.note)}
      >
        <Icon name="trash" class="size-3.5" />
        حذف
      </Button>
    </div>
  )

  const NoteItem = (props: { note: NoteRow }) => (
    <li class={rowStyle}>
      <div class="flex flex-wrap items-baseline gap-2">
        <button
          type="button"
          class="min-w-0 cursor-pointer text-start text-[0.95rem] leading-7 font-semibold break-words hover:text-primary hover:underline"
          onClick={() => navigate(`/notes/${props.note.id}`)}
        >
          {props.note.title}
        </button>
        <Show when={props.note.tagIds.length > 0}>
          <span class="flex flex-wrap gap-1">
            <For each={props.note.tagIds}>
              {(tagId) => <span class="badge badge-ghost badge-sm">{tagLabel(tagId)}</span>}
            </For>
          </span>
        </Show>
        <Show when={props.note.isPinned}>
          <span class="badge badge-primary badge-sm gap-1">
            <Icon name="pin" class="size-3" />
            پین
          </span>
        </Show>
      </div>
      <Show when={props.note.excerpt !== ""}>
        <p class="m-0 break-words text-sm leading-7 text-base-content/55">
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
            <mark class="rounded bg-warning/30 px-0.5 text-base-content">{segment.text}</mark>
          </Show>
        )}
      </For>
    </>
  )

  const SearchResult = (props: { hit: SearchHit }) => (
    <li class={rowStyle}>
      <button
        type="button"
        class="min-w-0 cursor-pointer text-start text-[0.95rem] leading-7 font-semibold break-words hover:text-primary hover:underline"
        onClick={() => navigate(`/notes/${props.hit.id}`)}
      >
        <Marked segments={titleSegments(props.hit)} />
      </button>
      <Show when={props.hit.segments.length > 0}>
        <p class="m-0 break-words text-sm leading-7 text-base-content/55">
          <Marked segments={snippetSegments(props.hit)} />
        </p>
      </Show>
    </li>
  )

  return (
    <div class="min-h-dvh overflow-x-clip bg-base-200 text-base-content" dir="rtl" lang="fa">
      <AppHeader active="notes" />

      <main class="page-wrap mx-auto grid max-w-3xl gap-4">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 class="m-0 text-2xl font-bold tracking-tight sm:text-3xl">یادداشت‌ها</h1>
            <p class="mt-1 mb-0 text-sm text-base-content/55">
              جست‌وجو، پین، آرشیو و برچسب — همه روی همین دستگاه اول ذخیره می‌شوند.
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <Button
              type="button"
              class="gap-1.5"
              onClick={() => void newNote()}
              disabled={busy() || local.store() === undefined}
            >
              <Icon name="plus" class="size-4" />
              یادداشت تازه
            </Button>
            <Button variant="ghost" type="button" class="gap-1.5" onClick={() => navigate("/notes/trash")}>
              <Icon name="trash" class="size-4" />
              سطل زباله
            </Button>
          </div>
        </header>

        <Show when={!local.online()}>
          <p role="status" class="soft-note m-0">
            آفلاین هستید؛ همه‌ی تغییرها روی همین دستگاه ذخیره می‌شوند و بعد همگام می‌شوند.
          </p>
        </Show>

        <section aria-label="جست‌وجو" class="panel grid gap-2 p-4">
          {/* The label wraps the input, so the field's accessible name is the
              hint text — and the query stays reachable by its label. */}
          <label class="grid gap-1.5">
            <span class="text-sm text-base-content/60">جست‌وجو در یادداشت‌ها (Ctrl+K)</span>
            <span class="flex items-center gap-2">
              <span class="input input-bordered flex flex-1 items-center gap-2">
                <Icon name="search" class="size-4 opacity-50" />
                <input
                  id="note-search"
                  ref={(element) => (searchInput = element)}
                  type="search"
                  class="grow bg-transparent text-[0.95rem] outline-none"
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
                />
              </span>
              <Show when={trimmed() !== ""}>
                <Button variant="ghost" size="sm" type="button" onClick={clearSearch}>
                  پاک کردن
                </Button>
              </Show>
            </span>
          </label>
          <Show when={searching()}>
            <p role="status" class="m-0 flex items-center gap-2 text-sm text-base-content/50">
              <span class="loading loading-spinner loading-xs" />
              در حال جست‌وجو…
            </p>
          </Show>
          <Show when={offlineSearch()}>
            <p role="status" class="soft-note m-0">
              جست‌وجو روی همین دستگاه انجام شد؛ نتیجه‌های سرور بعد از همگام‌سازی کامل می‌شود.
            </p>
          </Show>
        </section>

        <Show when={trimmed() !== ""}>
          <section aria-label="نتیجه‌های جست‌وجو" class="panel grid gap-1 p-4">
            <h2 class="m-0 text-lg font-bold">نتیجه‌ها</h2>
            <Show
              when={hits().length > 0}
              fallback={
                <p class="m-0 text-sm text-base-content/55">چیزی پیدا نشد.</p>
              }
            >
              <ul class="m-0 list-none divide-y divide-base-300 p-0">
                <For each={hits()}>{(hit) => <SearchResult hit={hit} />}</For>
              </ul>
            </Show>
          </section>
        </Show>

        <Show when={tags().length > 0}>
          <section aria-label="فیلتر برچسب" class="flex flex-wrap gap-1.5">
            <For each={tags()}>
              {(tag) => (
                <button
                  type="button"
                  aria-pressed={selectedTags().includes(tag.entityId) ? "true" : "false"}
                  onClick={() => toggleTag(tag.entityId)}
                  class={
                    selectedTags().includes(tag.entityId)
                      ? "badge badge-primary badge-lg cursor-pointer"
                      : "badge badge-ghost badge-lg cursor-pointer"
                  }
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
              <section class="panel grid gap-1 p-5">
                <p class="m-0 leading-8">هنوز یادداشتی ندارید.</p>
                <p class="m-0 text-sm text-base-content/55">
                  از هر صفحه با دکمه‌ی «یادداشت تازه» یا Alt+N شروع کنید؛ همان لحظه باز می‌شود.
                </p>
              </section>
            </Show>
          }
        >
          <Show when={pinned().length > 0}>
            <section aria-label="یادداشت‌های پین‌شده" class="panel grid gap-1 p-4 sm:p-5">
              <h2 class="m-0 flex items-center gap-1.5 text-lg font-bold">
                <Icon name="pin" class="size-4 text-primary" />
                پین‌شده
              </h2>
              <ul class="m-0 list-none divide-y divide-base-300 p-0">
                <For each={pinned()}>{(note) => <NoteItem note={note} />}</For>
              </ul>
            </section>
          </Show>

          <section aria-label="همه‌ی یادداشت‌ها" class="panel grid gap-1 p-4 sm:p-5">
            <h2 class="m-0 text-lg font-bold">یادداشت‌ها</h2>
            <Show
              when={unpinned().length > 0}
              fallback={
                <p class="m-0 text-sm text-base-content/55">یادداشت دیگری نیست.</p>
              }
            >
              <ul class="m-0 list-none divide-y divide-base-300 p-0">
                <For each={unpinned()}>{(note) => <NoteItem note={note} />}</For>
              </ul>
            </Show>
          </section>

          <section aria-label="آرشیو" class="panel grid gap-2 p-4 sm:p-5">
            <button
              type="button"
              class="btn btn-ghost btn-sm w-fit gap-1.5 rounded-full font-normal"
              aria-expanded={showArchived() ? "true" : "false"}
              onClick={() => setShowArchived(!showArchived())}
            >
              <Icon name="archive" class="size-4" />
              آرشیو ({archived().length})
            </button>
            <Show when={showArchived()}>
              <Show
                when={archived().length > 0}
                fallback={
                  <p class="m-0 text-sm text-base-content/55">آرشیو خالی است.</p>
                }
              >
                <ul class="m-0 list-none divide-y divide-base-300 p-0">
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
