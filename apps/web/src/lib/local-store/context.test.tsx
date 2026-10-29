import "fake-indexeddb/auto"
import { createEffect, createSignal, For, onSettled, Show } from "solid-js"
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { uuidV7, type SessionContext } from "@tali/domain"
import { AuthProvider } from "../auth"
import { LocalStoreProvider, useLocalStore, type LocalStoreContextValue } from "./context"
import type { MirrorRecord } from "./types"

/**
 * The exit criterion for #17, at the seam the UI uses: a write is visible
 * immediately, waits in the outbox, and is still there after a remount (which
 * is what a reload does).
 */

const session: SessionContext = {
  user: {
    id: uuidV7() as SessionContext["user"]["id"],
    email: "owner@example.com" as SessionContext["user"]["email"],
    displayName: "مالک",
    timeZone: "Asia/Tehran",
    weekStart: "saturday",
    digits: "persian"
  },
  householdId: uuidV7() as NonNullable<SessionContext["householdId"]>
}

const stubServer = (): void => {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(session), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch
}

function Probe() {
  const local = useLocalStore()
  const [items, setItems] = createSignal<ReadonlyArray<MirrorRecord>>([])

  createEffect(
    () => local.store(),
    (store) => {
      if (store === undefined) return
      const load = () => {
        void store.list("listItem").then(setItems).catch(() => undefined)
      }
      load()
      return store.subscribe(load)
    }
  )

  const add = () => {
    const store = local.store()
    if (store === undefined) return
    void store.writeLocal({
      entityType: "listItem",
      entityId: uuidV7(),
      op: "upsert",
      patch: { title: "نان" }
    })
  }

  return (
    <div>
      <span data-testid="status">{local.status()}</span>
      <span data-testid="pending">{String(local.pending())}</span>
      <button type="button" onClick={add}>
        add
      </button>
      <ul>
        <For each={items()}>{(row) => <li>{String(row.data.title)}</li>}</For>
      </ul>
      <Show when={local.store()}>{(store) => <span data-testid="user">{store().userId}</span>}</Show>
    </div>
  )
}

const mount = () =>
  render(() => (
    <AuthProvider>
      <LocalStoreProvider>
        <Probe />
      </LocalStoreProvider>
    </AuthProvider>
  ))

/**
 * Hands the test the live context value, so a pass can be started and observed
 * without rendering `SyncRunner`'s poll loop.
 */
function SyncProbe(props: { readonly onValue: (value: LocalStoreContextValue) => void }) {
  const local = useLocalStore()
  onSettled(() => props.onValue(local))
  return <span data-testid="sync-status">{local.status()}</span>
}

describe("LocalStoreProvider", () => {
  beforeEach(() => {
    localStorage.clear()
    stubServer()
  })

  it("opens a per-user mirror, queues a write, and rehydrates it after a remount", async () => {
    const first = mount()
    await waitFor(() => expect(first.getByTestId("status").textContent).toBe("ready"))
    expect(first.getByTestId("user").textContent).toBe(session.user.id)

    fireEvent.click(first.getByRole("button", { name: "add" }))

    // Visible immediately, and queued.
    await waitFor(() => expect(first.getByText("نان")).toBeInTheDocument())
    await waitFor(() => expect(first.getByTestId("pending").textContent).toBe("1"))
    first.unmount()

    // A fresh mount is a reload: the mirror opens again and the outbox is intact.
    const second = mount()
    await waitFor(() => expect(second.getByTestId("status").textContent).toBe("ready"))
    await waitFor(() => expect(second.getByText("نان")).toBeInTheDocument())
    expect(second.getByTestId("pending").textContent).toBe("1")
    second.unmount()
  })

  it("boots from the cached session when the server is unreachable", async () => {
    localStorage.setItem("tali.session.v1", JSON.stringify(session))
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch

    const view = mount()
    await waitFor(() => expect(view.getByTestId("status").textContent).toBe("ready"))
    expect(view.getByTestId("user").textContent).toBe(session.user.id)
    view.unmount()
  })

  it("runs exactly one trailing pass for triggers that land mid-pass", async () => {
    // Test files share one jsdom environment (`isolate: false`) and the
    // offline screen tests flip `navigator.onLine` without restoring it. This
    // test needs the online path, so state it rather than inherit it.
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })

    let local: LocalStoreContextValue | undefined
    const view = render(() => (
      <AuthProvider>
        <LocalStoreProvider>
          <SyncProbe
            onValue={(value) => {
              local = value
            }}
          />
        </LocalStoreProvider>
      </AuthProvider>
    ))
    await waitFor(() => expect(view.getByTestId("sync-status").textContent).toBe("ready"))

    let calls = 0
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    local!.registerSync(async () => {
      calls += 1
      if (calls === 1) await gate
    })
    // Solid 2 commits signal writes on the next microtask.
    await waitFor(() => expect(local!.canSync()).toBe(true))

    const first = local!.syncNow()
    await waitFor(() => expect(calls).toBe(1))
    expect(local!.syncing()).toBe(true)

    // A write during the pass wakes `syncNow` through SyncRunner's pending
    // effect; the pass in flight may already have read the outbox, so it must
    // not wait for the next poll.
    await local!.store()!.writeLocal({
      entityType: "listItem",
      entityId: uuidV7(),
      op: "upsert",
      patch: { title: "در حین" }
    })
    const second = local!.syncNow()
    // A second trigger while the rerun is already queued adds nothing.
    const third = local!.syncNow()
    expect(local!.syncing()).toBe(true)

    release()
    await Promise.all([first, second, third])

    expect(calls).toBe(2)
    expect(local!.syncing()).toBe(false)
    view.unmount()
  })

  it("counts consecutive failures, resets after a clean pass, and halts on a 401", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })

    let local: LocalStoreContextValue | undefined
    const view = render(() => (
      <AuthProvider>
        <LocalStoreProvider>
          <SyncProbe
            onValue={(value) => {
              local = value
            }}
          />
        </LocalStoreProvider>
      </AuthProvider>
    ))
    await waitFor(() => expect(view.getByTestId("sync-status").textContent).toBe("ready"))

    let calls = 0
    let mode: "fail" | "ok" | "unauthorized" = "fail"
    local!.registerSync(async () => {
      calls += 1
      if (mode === "fail") throw new Error("boom")
      if (mode === "unauthorized") {
        throw Object.assign(new Error("Unauthorized"), { code: "Unauthorized" })
      }
    })
    await waitFor(() => expect(local!.canSync()).toBe(true))

    await local!.syncNow()
    expect(local!.failures()).toBe(1)
    await local!.syncNow()
    expect(local!.failures()).toBe(2)

    // A pass that did not throw is the reset.
    mode = "ok"
    await local!.syncNow()
    expect(local!.failures()).toBe(0)

    // The session is gone: keep the error visible but stop burning polls.
    mode = "unauthorized"
    await local!.syncNow()
    expect(local!.halted()).toBe(true)
    const afterHalt = calls
    await local!.syncNow()
    expect(calls).toBe(afterHalt)

    view.unmount()
  })

  it("refreshes the failure count on open, a drained pass and a one-minute gate", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })

    let local: LocalStoreContextValue | undefined
    const view = render(() => (
      <AuthProvider>
        <LocalStoreProvider>
          <SyncProbe
            onValue={(value) => {
              local = value
            }}
          />
        </LocalStoreProvider>
      </AuthProvider>
    ))
    await waitFor(() => expect(view.getByTestId("sync-status").textContent).toBe("ready"))

    const store = local!.store()!
    local!.registerSync(async () => {})
    await waitFor(() => expect(local!.canSync()).toBe(true))

    // The open-time seed is the last scan. A pass over an empty outbox must not
    // start another: `failedCount()` is `getAll()` over the whole mirror.
    const failedCount = vi.spyOn(store, "failedCount")
    await local!.syncNow()
    await local!.syncNow()
    expect(failedCount).not.toHaveBeenCalled()

    // The gate is a minute from the last scan: the first pass past it refreshes
    // the count, and the next minute of passes trusts that result…
    const openedAt = Date.now()
    const clock = vi.spyOn(Date, "now")
    clock.mockReturnValue(openedAt + 60_000)
    await local!.syncNow()
    expect(failedCount).toHaveBeenCalledTimes(1)

    clock.mockReturnValue(openedAt + 60_000 + 59_999)
    await local!.syncNow()
    expect(failedCount).toHaveBeenCalledTimes(1)

    // …until another minute has passed.
    clock.mockReturnValue(openedAt + 60_000 + 60_000)
    await local!.syncNow()
    expect(failedCount).toHaveBeenCalledTimes(2)
    clock.mockRestore()

    // A pass that drains the outbox is the one moment a push result can have
    // marked rows, so it refreshes even inside the minute.
    local!.registerSync(async (current) => {
      const [entry] = await current.pending()
      if (entry !== undefined) await current.ack([entry.clientMutationId])
    })
    await waitFor(() => expect(local!.canSync()).toBe(true))
    const queued = local!.pending()
    await store.writeLocal({
      entityType: "listItem",
      entityId: uuidV7(),
      op: "upsert",
      patch: { title: "صف" }
    })
    await waitFor(() => expect(local!.pending()).toBe(queued + 1))
    failedCount.mockClear()
    await local!.syncNow()
    expect(failedCount).toHaveBeenCalledTimes(1)
    failedCount.mockRestore()

    view.unmount()
  })
})
