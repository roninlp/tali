import "fake-indexeddb/auto"
import { createEffect, createSignal, For, Show } from "solid-js"
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { uuidV7, type SessionContext } from "@tali/domain"
import { AuthProvider } from "../auth"
import { LocalStoreProvider, useLocalStore } from "./context"
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
})
