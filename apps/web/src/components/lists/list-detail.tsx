import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Button, tokens } from "@tali/ui"
import { localizeDigits, type ListItemSort } from "@tali/domain"
import { useAuth } from "../../lib/auth"
import { useLocalStore } from "../../lib/local-store"
import { usePreferences } from "../../lib/preferences"
import {
  createListItemInMirror,
  deleteListItemInMirror,
  deleteListInMirror,
  reorderListItemsInMirror,
  setListItemCheckedInMirror,
  updateListInMirror
} from "../../lib/lists/mirror"
import {
  droppedOrder,
  buildListItemsView,
  movedOrder,
  nextItemOrder,
  pendingItemIds,
  pendingListIds,
  stableItemRows,
  toListItemRow,
  toListRow,
  UPDATED_BY_OTHER_LABEL,
  writtenByOther,
  type ListItemRow,
  type ListRow
} from "../../lib/lists/model"
import {
  ListsStyles,
  LISTS_ROOT,
  listsCardStyle,
  listsDangerButtonStyle,
  listsInputStyle,
  listsScreenStyle,
  listsSelectStyle,
  listsSmallButtonStyle
} from "./ui"

/**
 * `/lists/:id` (FR-LIST-01/02/03).
 *
 * Continuous entry keeps the input focused across Enter; checking animates the
 * strike-through, groups checked items by the list's preference, and offers a
 * short undo toast. Manual ordering is drag **and** arrow-buttons, so touch,
 * keyboard and pointer all have a path. All writes are local-first.
 */
export function ListDetailScreen() {
  const params = useParams<{ id: string }>()
  const local = useLocalStore()
  const preferences = usePreferences()
  const auth = useAuth()
  const navigate = useNavigate()

  const [list, setList] = createSignal<ListRow>()
  const [items, setItems] = createSignal<ReadonlyArray<ListItemRow>>([])
  const [pending, setPending] = createSignal<ReadonlyArray<{ readonly entityType: string; readonly entityId: string }>>([])
  const [loadState, setLoadState] = createSignal<"loading" | "ready" | "missing">("loading")
  const [titleDraft, setTitleDraft] = createSignal("")
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [pageError, setPageError] = createSignal<string>()
  const [toast, setToast] = createSignal<ListItemRow>()
  const [dragging, setDragging] = createSignal<string>()
  const [dragOver, setDragOver] = createSignal<string>()

  let titleRef: HTMLInputElement | undefined
  let inputRef: HTMLInputElement | undefined
  let addForm: HTMLFormElement | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * The list id whose rows are already on screen. Only a *different* list may
   * blank the detail: the loading branch unmounts the entry composer, so
   * re-running this effect (e.g. the mirror provider re-opening after a
   * session transition) must not throw away what is being typed.
   */
  let loadedId: string | undefined

  const digits = () => preferences.preferences().digits
  const userId = () => auth.session()?.user.id
  const pendingLists = createMemo(() => pendingListIds(pending()))
  const pendingItems = createMemo(() => pendingItemIds(pending()))
  const view = createMemo(() => {
    const current = list()
    return current === undefined
      ? { open: [], checked: [], visible: [], total: 0, doneCount: 0 }
      : buildListItemsView(current, items())
  })

  onCleanup(() => clearTimeout(toastTimer))

  const reportError = (cause: unknown) => {
    setPageError(cause instanceof Error ? cause.message : "ذخیره در حافظه‌ی محلی ناموفق بود")
  }

  // Mirror → screen. Reloads after every local write or server ack.
  createEffect(
    () => ({ store: local.store(), id: params.id }),
    ({ store, id }) => {
      if (store === undefined) return
      // Blank the screen only on a genuine first load / different list; a
      // reload of the list already on screen keeps the composer mounted.
      if (loadedId !== id) {
        loadedId = undefined
        setLoadState("loading")
      }
      let cancelled = false
      const reload = () => {
        void Promise.all([
          store.get("list", id),
          store.list("listItem"),
          store.pending()
        ])
          .then(async ([listRecord, itemRecords, pendingRows]) => {
            if (cancelled) return
            const listRow = listRecord === undefined ? undefined : toListRow(listRecord)
            const itemRows = itemRecords
              .map(toListItemRow)
              .filter((item) => item.listId === id)
            if (cancelled) return
            // Keep unchanged rows' object identity so an ack does not remount
            // them (focus, strike-through animation, drag state).
            setItems((previous) => stableItemRows(previous, itemRows))
            setPending(pendingRows)
            if (listRow === undefined) {
              setList(undefined)
              setLoadState("missing")
              return
            }
            setList(listRow)
            loadedId = id
            setLoadState("ready")
            if (document.activeElement !== titleRef) setTitleDraft(listRow.title)
          })
          .catch(() => {
            // Store closed mid-read (sign-out); the provider will reopen it.
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

  const listWriter = () => list()?.lastWriterId ?? null

  const itemWriter = (item: ListItemRow) => item.lastWriterId

  const commitReorder = async (orderedIds: ReadonlyArray<string>) => {
    const store = local.store()
    if (store === undefined) return
    try {
      await reorderListItemsInMirror(store, items(), orderedIds)
    } catch (cause) {
      reportError(cause)
    }
  }

  const renameList = async (event: SubmitEvent) => {
    event.preventDefault()
    const store = local.store()
    const current = list()
    if (store === undefined || current === undefined) return
    const title = titleDraft().trim()
    if (title === "") {
      setTitleDraft(current.title)
      return
    }
    if (title === current.title) return
    setPageError(undefined)
    try {
      await updateListInMirror(store, current.id, { title })
    } catch (cause) {
      reportError(cause)
    }
  }

  const patchList = async (patch: Parameters<typeof updateListInMirror>[2]) => {
    const store = local.store()
    const current = list()
    if (store === undefined || current === undefined) return
    setPageError(undefined)
    try {
      await updateListInMirror(store, current.id, patch)
    } catch (cause) {
      reportError(cause)
    }
  }

  const addItem = async (event: SubmitEvent) => {
    event.preventDefault()
    const store = local.store()
    const current = list()
    const name = draft().trim()
    if (store === undefined || current === undefined || name === "" || busy()) return
    setBusy(true)
    setPageError(undefined)
    // Keep the caret in the composer while the mirror transaction settles —
    // but never pull focus away from a control the user moved to meanwhile.
    const composerOwnsFocus = () => {
      const active = document.activeElement
      return (
        active === null ||
        active === document.body ||
        (addForm !== undefined && active instanceof Node && addForm.contains(active))
      )
    }
    const returnFocus = composerOwnsFocus()
    try {
      await createListItemInMirror(store, current.id, {
        name,
        order: nextItemOrder(items()),
        visibility: current.visibility === "private" ? "private" : "shared"
      })
      // Clear only what was submitted: the next item may already be typed
      // while the mirror write settles (the five-Enters path).
      setDraft((value) => (value.trim() === name ? "" : value))
    } catch (cause) {
      reportError(cause)
    } finally {
      setBusy(false)
      if (returnFocus) inputRef?.focus()
    }
  }

  const showCheckedToast = (item: ListItemRow) => {
    clearTimeout(toastTimer)
    setToast(item)
    toastTimer = setTimeout(() => setToast(undefined), 6000)
  }

  const toggleItem = async (item: ListItemRow) => {
    const store = local.store()
    if (store === undefined) return
    setPageError(undefined)
    try {
      const now = new Date().toISOString()
      if (item.done) {
        await setListItemCheckedInMirror(store, item, false, now)
        return
      }
      await setListItemCheckedInMirror(store, item, true, now)
      showCheckedToast({ ...item, done: true, checkedAt: now })
    } catch (cause) {
      reportError(cause)
    }
  }

  const undoCheck = async () => {
    const store = local.store()
    const checked = toast()
    if (store === undefined || checked === undefined) return
    clearTimeout(toastTimer)
    setToast(undefined)
    try {
      // Force the uncheck even though the toast snapshot predates the tick.
      await setListItemCheckedInMirror(
        store,
        { ...checked, done: true, checkedAt: checked.checkedAt ?? new Date().toISOString() },
        false
      )
    } catch (cause) {
      reportError(cause)
    }
  }

  const removeItem = async (item: ListItemRow) => {
    const store = local.store()
    if (store === undefined) return
    setPageError(undefined)
    try {
      await deleteListItemInMirror(store, item.id)
    } catch (cause) {
      reportError(cause)
    }
  }

  const move = (item: ListItemRow, direction: -1 | 1) => {
    void commitReorder(movedOrder(items(), item.id, direction))
  }

  const drop = (target: ListItemRow) => {
    const source = dragging()
    setDragging(undefined)
    setDragOver(undefined)
    if (source === undefined || source === target.id) return
    void commitReorder(droppedOrder(items(), source, target.id))
  }

  const removeList = async () => {
    const store = local.store()
    const current = list()
    if (store === undefined || current === undefined) return
    const confirmed =
      typeof window === "undefined" ||
      window.confirm(`فهرست «${current.title}» حذف شود؟`)
    if (!confirmed) return
    setPageError(undefined)
    try {
      await deleteListInMirror(store, current.id, items())
      navigate("/lists")
    } catch (cause) {
      reportError(cause)
    }
  }

  const isPending = () => {
    const current = list()
    return current === undefined
      ? false
      : pendingLists().has(current.id) ||
        items().some((item) => pendingItems().has(item.id))
  }

  return (
    <div class="lists-root" dir="rtl" lang="fa" style={LISTS_ROOT}>
      <ListsStyles />
      <main style={listsScreenStyle}>
        <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
          <button
            type="button"
            style={listsSmallButtonStyle()}
            onClick={() => navigate("/lists")}
          >
            → همه‌ی فهرست‌ها
          </button>
        </div>

        <Show
          when={loadState() !== "loading"}
          fallback={
            <p class="lists-empty" role="status">
              در حال آماده‌سازی فهرست…
            </p>
          }
        >
          <Show
            when={loadState() === "ready" && list() !== undefined}
            fallback={
              <p class="lists-empty" role="status">
                این فهرست پیدا نشد یا حذف شده است.
              </p>
            }
          >
            <div class="lists-detail">
              <header style={listsCardStyle}>
                <div class="lists-header">
                  <form
                    onSubmit={(event) => void renameList(event)}
                    class="lists-header-row"
                  >
                    <label style={{ display: "grid", gap: "2px", flex: 1, "min-width": 0 }}>
                      <span style={{ "font-size": "0.76rem", color: tokens.color.inkSoft }}>
                        عنوان فهرست
                      </span>
                      <input
                        ref={(element) => (titleRef = element)}
                        name="listTitle"
                        value={titleDraft()}
                        maxlength={120}
                        onInput={(event) => setTitleDraft(event.currentTarget.value)}
                        onBlur={(event) => {
                          if (event.currentTarget.value.trim() === "") {
                            setTitleDraft(list()?.title ?? "")
                          }
                        }}
                        style={{ ...listsInputStyle, "font-size": "1.1rem", "font-weight": 600 }}
                      />
                    </label>
                    <div class="lists-header-actions" style={{ "align-self": "end" }}>
                      <Button type="submit" variant="ghost">
                        ذخیره‌ی نام
                      </Button>
                      <button
                        type="button"
                        style={listsDangerButtonStyle}
                        onClick={() => void removeList()}
                      >
                        حذف فهرست
                      </button>
                    </div>
                  </form>

                  <div class="lists-item-meta" aria-live="polite">
                    <span>
                      {localizeDigits(view().total, digits())} مورد ·{" "}
                      {localizeDigits(view().doneCount, digits())} انجام‌شده
                    </span>
                    <Show when={list()?.visibility === "private"}>
                      <span>خصوصی</span>
                    </Show>
                    <Show when={isPending()}>
                      <span style={{ color: "#92600e" }}>در انتظار ارسال</span>
                    </Show>
                    <Show
                      when={writtenByOther(
                        listWriter(),
                        userId(),
                        list()?.version ?? 1
                      )}
                    >
                      <span>{UPDATED_BY_OTHER_LABEL}</span>
                    </Show>
                  </div>

                  <div class="lists-controls">
                    <label class="lists-control">
                      <span>مرتب‌سازی</span>
                      <select
                        value={list()?.sort ?? "manual"}
                        onChange={(event) =>
                          void patchList({ sort: event.currentTarget.value as ListItemSort })
                        }
                        style={listsSelectStyle}
                      >
                        <option value="manual">دستی</option>
                        <option value="alpha">الفبا</option>
                        <option value="status">وضعیت</option>
                      </select>
                    </label>
                    <label class="lists-control">
                      <span>جای موارد تیک‌خورده</span>
                      <select
                        value={list()?.checkedPlacement ?? "bottom"}
                        onChange={(event) =>
                          void patchList({
                            checkedPlacement:
                              event.currentTarget.value === "inPlace" ? "inPlace" : "bottom"
                          })
                        }
                        style={listsSelectStyle}
                      >
                        <option value="bottom">انتهای فهرست</option>
                        <option value="inPlace">همان‌جا</option>
                      </select>
                    </label>
                    <label class="lists-control">
                      <span>دسترسی</span>
                      <select
                        value={list()?.visibility ?? "shared"}
                        disabled={(list()?.ownerId ?? "") !== (userId() ?? "")}
                        onChange={(event) =>
                          void patchList({
                            visibility:
                              event.currentTarget.value === "private" ? "private" : "shared"
                          })
                        }
                        style={listsSelectStyle}
                      >
                        <option value="shared">مشترک با خانه</option>
                        <option value="private">فقط خودم</option>
                      </select>
                    </label>
                  </div>
                </div>
              </header>

              <section style={listsCardStyle} aria-labelledby="lists-entry-title">
                <h2 id="lists-entry-title" style={{ margin: 0, "font-size": "1.02rem" }}>
                  افزودن مورد
                </h2>
                <form
                  class="lists-add"
                  ref={(element) => (addForm = element)}
                  onSubmit={(event) => void addItem(event)}
                >
                  <input
                    ref={(element) => (inputRef = element)}
                    name="itemName"
                    aria-label="نام مورد تازه"
                    placeholder="مورد تازه… (Enter برای مورد بعد)"
                    autocomplete="off"
                    maxlength={200}
                    value={draft()}
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    style={listsInputStyle}
                  />
                  <Button type="submit" disabled={busy() || draft().trim() === ""}>
                    افزودن
                  </Button>
                </form>
                <p class="lists-hint">
                  تایپ کنید و Enter بزنید؛ نشانگر در همین کادر می‌ماند تا مورد بعدی را بنویسید.
                </p>
              </section>

              <Show when={pageError()}>
                <p role="alert" style={{ margin: 0, color: "#9f1239", "font-size": "0.85rem", "line-height": "1.8" }}>
                  {pageError()}
                </p>
              </Show>

              <Show
                when={view().visible.length > 0}
                fallback={
                  <p class="lists-empty">هنوز موردی ندارد. اولین مورد را از کادر بالا اضافه کنید.</p>
                }
              >
                <ul class="lists-items" aria-label="موارد فهرست">
                  <For each={view().visible}>
                    {(item) => {
                      const canReorder = () => list()?.sort === "manual"
                      return (
                        <li
                          class="lists-item"
                          data-done={item.done ? "true" : "false"}
                          data-dragging={dragging() === item.id ? "true" : "false"}
                          data-over={dragOver() === item.id ? "true" : "false"}
                          draggable={canReorder() ? "true" : "false"}
                          onDragStart={(event) => {
                            if (!canReorder()) return
                            event.dataTransfer?.setData("text/plain", item.id)
                            setDragging(item.id)
                          }}
                          onDragOver={(event) => {
                            if (!canReorder()) return
                            event.preventDefault()
                            setDragOver(item.id)
                          }}
                          onDragLeave={() => setDragOver(undefined)}
                          onDrop={(event) => {
                            if (!canReorder()) return
                            event.preventDefault()
                            drop(item)
                          }}
                          onDragEnd={() => {
                            setDragging(undefined)
                            setDragOver(undefined)
                          }}
                        >
                          <button
                            type="button"
                            class="lists-check"
                            role="checkbox"
                            aria-checked={item.done ? "true" : "false"}
                            aria-label={`${item.done ? "برداشتن تیک" : "تیک زدن"} ${item.name}`}
                            onClick={() => void toggleItem(item)}
                          >
                            {item.done ? "✓" : ""}
                          </button>

                          <div class="lists-item-body">
                            <span class="lists-item-name">{item.name}</span>
                            <div class="lists-item-meta">
                              <Show when={pendingItems().has(item.id)}>
                                <span style={{ color: "#92600e" }}>در انتظار ارسال</span>
                              </Show>
                              <Show when={item.done}>
                                <span>انجام‌شده</span>
                              </Show>
                              <Show when={writtenByOther(itemWriter(item), userId(), item.version)}>
                                <span>{UPDATED_BY_OTHER_LABEL}</span>
                              </Show>
                            </div>
                          </div>

                          <div class="lists-item-actions">
                            <Show when={canReorder()}>
                              <button
                                type="button"
                                style={listsSmallButtonStyle()}
                                aria-label={`جابه‌جایی ${item.name} به بالا`}
                                title="بالا"
                                onClick={() => move(item, -1)}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                style={listsSmallButtonStyle()}
                                aria-label={`جابه‌جایی ${item.name} به پایین`}
                                title="پایین"
                                onClick={() => move(item, 1)}
                              >
                                ↓
                              </button>
                            </Show>
                            <button
                              type="button"
                              style={listsDangerButtonStyle}
                              aria-label={`حذف ${item.name}`}
                              onClick={() => void removeItem(item)}
                            >
                              حذف
                            </button>
                          </div>
                        </li>
                      )
                    }}
                  </For>
                </ul>
              </Show>

              <Show when={list()?.sort === "manual"}>
                <p class="lists-hint">
                  برای جابه‌جایی دستی، از دکمه‌های ↑/↓ استفاده کنید؛ روی صفحه‌های بزرگ می‌توانید
                  ردیف را بکشید.
                </p>
              </Show>
            </div>
          </Show>
        </Show>
      </main>

      <Show when={toast()}>
        {(item) => (
          <div class="lists-toast" role="status" aria-live="polite">
            <p>تیک خورد: {item().name}</p>
            <button type="button" onClick={() => void undoCheck()}>
              بازگرداندن
            </button>
          </div>
        )}
      </Show>
    </div>
  )
}
