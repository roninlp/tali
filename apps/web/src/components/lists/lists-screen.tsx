import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { Button } from "@tali/ui"
import { localizeDigits } from "@tali/domain"
import { useLocalStore } from "../../lib/local-store"
import { usePreferences } from "../../lib/preferences"
import { useNavigate } from "@solidjs/router"
import {
  createListInMirror,
  deleteListInMirror,
  type ListDraft
} from "../../lib/lists/mirror"
import {
  pendingItemIds,
  pendingListIds,
  sortLists,
  summarizeList,
  toListItemRow,
  toListRow,
  type ListItemRow,
  type ListRow
} from "../../lib/lists/model"
import {
  COLOR_CHOICES,
  ICON_CHOICES,
  LISTS_ROOT_CLASS,
  ListsStyles,
  listsDangerButtonStyle,
  listsScreenClass,
  listsSmallButtonStyle
} from "./ui"

/**
 * `/lists` index (FR-LIST-01/02/03): create a list with a title, colour and
 * icon, then see open/checked counts and a two-item preview. Everything reads
 * the mirror, so counts are correct offline; creation queues in the outbox.
 */
export function ListsScreen() {
  const local = useLocalStore()
  const preferences = usePreferences()
  const navigate = useNavigate()

  const [lists, setLists] = createSignal<ReadonlyArray<ListRow>>([])
  const [items, setItems] = createSignal<ReadonlyArray<ListItemRow>>([])
  const [pending, setPending] = createSignal<ReadonlyArray<{ readonly entityType: string; readonly entityId: string }>>([])
  const [title, setTitle] = createSignal("")
  const [color, setColor] = createSignal<string | null>(COLOR_CHOICES[0])
  const [icon, setIcon] = createSignal<string | null>(ICON_CHOICES[0])
  const [visibility, setVisibility] = createSignal<"shared" | "private">("shared")
  const [busy, setBusy] = createSignal(false)
  const [pageError, setPageError] = createSignal<string>()

  const digits = () => preferences.preferences().digits
  const pendingLists = createMemo(() => pendingListIds(pending()))
  const pendingItems = createMemo(() => pendingItemIds(pending()))

  createEffect(
    () => local.store(),
    (store) => {
      if (store === undefined) {
        setLists([])
        setItems([])
        setPending([])
        return
      }
      let cancelled = false
      const reload = () => {
        void Promise.all([store.list("list"), store.list("listItem"), store.pending()])
          .then(([listRows, itemRows, pendingRows]) => {
            if (cancelled) return
            setLists(listRows.map(toListRow))
            setItems(itemRows.map(toListItemRow))
            setPending(pendingRows)
          })
          .catch(() => {
            // The store closed mid-read (sign-out); the next open reloads.
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

  const summaries = createMemo(() => {
    const byList = new Map<string, Array<ListItemRow>>()
    for (const item of items()) {
      const bucket = byList.get(item.listId) ?? []
      bucket.push(item)
      byList.set(item.listId, bucket)
    }
    return sortLists(lists()).map((list) => summarizeList(list, byList.get(list.id) ?? []))
  })

  const reportError = (cause: unknown) => {
    setPageError(cause instanceof Error ? cause.message : "ذخیره در حافظه‌ی محلی ناموفق بود")
  }

  const create = async (event: SubmitEvent) => {
    event.preventDefault()
    const store = local.store()
    if (store === undefined || busy()) return
    const listTitle = title().trim()
    if (listTitle === "") return
    setBusy(true)
    setPageError(undefined)
    try {
      const draft: ListDraft = {
        title: listTitle,
        color: color(),
        icon: icon(),
        sort: "manual",
        checkedPlacement: preferences.preferences().checkedItemPlacement,
        visibility: visibility()
      }
      const id = await createListInMirror(store, draft)
      setTitle("")
      navigate(`/lists/${id}`)
    } catch (cause) {
      reportError(cause)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (list: ListRow) => {
    const store = local.store()
    if (store === undefined) return
    const confirmed =
      typeof window === "undefined" ||
      window.confirm(`فهرست «${list.title}» حذف شود؟ موارد آن هم از نمای شما پنهان می‌شوند.`)
    if (!confirmed) return
    setPageError(undefined)
    try {
      await deleteListInMirror(
        store,
        list.id,
        items().filter((item) => item.listId === list.id)
      )
    } catch (cause) {
      reportError(cause)
    }
  }

  return (
    <div class={LISTS_ROOT_CLASS} dir="rtl" lang="fa">
      <ListsStyles />
      <main class={listsScreenClass}>
        <header class="panel grid gap-1.5 p-5">
          <h1 class="m-0 text-2xl font-bold tracking-tight sm:text-3xl">فهرست‌ها</h1>
          <p class="m-0 text-sm leading-7 text-base-content/55">
            فهرست خرید، کارهای خانه یا هر چک‌لیست مشترک. هر تغییر اول روی همین دستگاه ذخیره می‌شود.
          </p>
          <Show when={!local.online()}>
            <p class="lists-hint" role="status">
              آفلاین هستید: ساخت فهرست و افزودن مورد کار می‌کند و بعداً همگام می‌شود.
            </p>
          </Show>
          <Show when={local.pending() > 0}>
            <p
              role="status"
              aria-live="polite"
              class="m-0 text-[0.78rem] text-base-content/50"
            >
              {localizeDigits(local.pending(), digits())} تغییر در صف همگام‌سازی است.
            </p>
          </Show>
        </header>

        <section class="panel grid gap-3 p-5" aria-labelledby="lists-create-title">
          <h2 id="lists-create-title" class="m-0 text-lg font-bold">
            فهرست تازه
          </h2>
          <form onSubmit={(event) => void create(event)} class="grid gap-3">
            <label class="grid gap-1">
              <span class="text-[0.8rem] text-base-content/55">عنوان</span>
              <input
                name="title"
                required
                maxlength={120}
                autocomplete="off"
                placeholder="مثلاً خرید هفتگی"
                value={title()}
                disabled={busy()}
                onInput={(event) => setTitle(event.currentTarget.value)}
                class="input input-bordered w-full"
              />
            </label>

            <div class="grid gap-3 sm:grid-cols-2">
              <fieldset class="m-0 grid gap-1.5 border-0 p-0">
                <legend class="text-[0.8rem] text-base-content/55">رنگ</legend>
                <div class="flex flex-wrap gap-2">
                <For each={COLOR_CHOICES}>
                  {(choice) => (
                    <button
                      type="button"
                      aria-label={`رنگ ${choice}`}
                      aria-pressed={color() === choice ? "true" : "false"}
                      onClick={() => setColor(choice)}
                      class="size-9 rounded-full"
                      style={{
                        background: choice,
                        border:
                          color() === choice
                            ? "3px solid var(--color-base-content)"
                            : "1px solid var(--color-base-300)",
                        "box-shadow":
                          color() === choice ? "0 0 0 2px var(--color-base-100) inset" : undefined,
                        cursor: "pointer"
                      }}
                    />
                  )}
                </For>
              </div>
            </fieldset>

            <fieldset class="m-0 grid gap-1.5 border-0 p-0">
              <legend class="text-[0.8rem] text-base-content/55">نماد</legend>
              <div class="flex flex-wrap gap-1.5">
                <For each={ICON_CHOICES}>
                  {(choice) => (
                    <button
                      type="button"
                      aria-label={`نماد ${choice}`}
                      aria-pressed={icon() === choice ? "true" : "false"}
                      onClick={() => setIcon(choice)}
                      style={{
                        ...listsSmallButtonStyle(icon() === choice),
                        "font-size": "1.05rem",
                        width: "40px",
                        height: "40px",
                        "justify-content": "center"
                      }}
                    >
                      {choice}
                    </button>
                  )}
                </For>
              </div>
            </fieldset>
            </div>

            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                class="checkbox checkbox-primary checkbox-sm"
                checked={visibility() === "private"}
                onChange={(event) => setVisibility(event.currentTarget.checked ? "private" : "shared")}
              />
              فقط خودم ببینم (خصوصی)
            </label>

            <Show when={pageError()}>
              <p role="alert" class="alert alert-error m-0 py-2 text-sm leading-7">
                {pageError()}
              </p>
            </Show>

            <div class="flex justify-end">
              <Button type="submit" disabled={busy() || title().trim() === ""} loading={busy()}>
                ساختن فهرست
              </Button>
            </div>
          </form>
        </section>

        <section aria-labelledby="lists-all-title" class="grid gap-2">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="lists-all-title" class="m-0 text-xl font-bold">
              همه‌ی فهرست‌ها
            </h2>
            <span class="text-[0.8rem] text-base-content/50">
              {localizeDigits(summaries().length, digits())} فهرست
            </span>
          </div>
          <Show
            when={summaries().length > 0}
            fallback={
              <p class="lists-empty panel p-5">
                هنوز فهرستی نساخته‌اید. یک عنوان بگذارید و «ساختن فهرست» را بزنید.
              </p>
            }
          >
            <div class="lists-index-grid">
              <For each={summaries()}>
                {(entry) => {
                  const isPending = () => pendingLists().has(entry.list.id)
                  const itemPending = () =>
                    items().some(
                      (item) => item.listId === entry.list.id && pendingItems().has(item.id)
                    )
                  return (
                    <article
                      class="lists-index-card"
                      data-pending={isPending() || itemPending() ? "true" : "false"}
                    >
                      <a
                        class="lists-index-link"
                        href={`/lists/${entry.list.id}`}
                        onClick={(event) => {
                          event.preventDefault()
                          navigate(`/lists/${entry.list.id}`)
                        }}
                      >
                        <h3 class="lists-title">
                          <Show when={entry.list.icon}>
                            {(iconValue) => <span class="lists-title-icon">{iconValue()}</span>}
                          </Show>
                          <span>{entry.list.title}</span>
                        </h3>
                        <p class="lists-sub">
                          {localizeDigits(entry.open, digits())} باز ·{" "}
                          {localizeDigits(entry.done, digits())} انجام‌شده
                          <Show when={entry.list.visibility === "private"}> · خصوصی</Show>
                        </p>
                        <Show when={entry.preview.length > 0}>
                          <ul class="lists-preview">
                            <For each={entry.preview}>{(name) => <li>{name}</li>}</For>
                          </ul>
                        </Show>
                      </a>
                      <div class="lists-index-actions">
                        <Show when={isPending() || itemPending()}>
                          <span class="badge badge-warning badge-sm">در انتظار ارسال</span>
                        </Show>
                        <button
                          type="button"
                          style={listsDangerButtonStyle}
                          onClick={() => void remove(entry.list)}
                        >
                          حذف
                        </button>
                      </div>
                    </article>
                  )
                }}
              </For>
            </div>
          </Show>
        </section>
      </main>
    </div>
  )
}
