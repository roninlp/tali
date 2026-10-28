import "fake-indexeddb/auto"
import { render, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { uuidV7, type SessionContext } from "@tali/domain"
import { AuthProvider } from "../lib/auth"
import {
  LocalStoreProvider,
  useLocalStore,
  type LocalStoreContextValue
} from "../lib/local-store"
import { SyncStatus } from "./sync-status"

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

let local: LocalStoreContextValue | undefined

function Probe() {
  local = useLocalStore()
  return <SyncStatus />
}

const mount = () =>
  render(() => (
    <AuthProvider>
      <LocalStoreProvider>
        <Probe />
      </LocalStoreProvider>
    </AuthProvider>
  ))

describe("SyncStatus", () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
    stubServer()
  })

  it("shows the failed state instead of the synced label", async () => {
    const view = mount()
    await waitFor(() => expect(local!.status()).toBe("ready"))
    let rejectNext = false
    local!.registerSync(async (current) => {
      if (!rejectNext) return
      const [entry] = await current.pending()
      if (entry === undefined) return
      await current.ack([entry.clientMutationId], [], [
        {
          entityType: entry.entityType,
          entityId: entry.entityId,
          code: "InvalidPatch",
          message: "The patch is not valid",
          at: "2026-10-20T09:00:00.000Z",
          clientMutationId: entry.clientMutationId
        }
      ])
    })
    await waitFor(() => expect(view.getByRole("status").textContent).toContain("همگام"))
    // Let the open-time count settle before pinning the cheap path.
    await local!.syncNow()

    const store = local!.store()!
    const failedCount = vi.spyOn(store, "failedCount")
    const id = uuidV7()
    await store.writeLocal({
      entityType: "listItem",
      entityId: id,
      op: "upsert",
      patch: { title: "ذخیره‌نشده" }
    })
    await waitFor(() => expect(local!.pending()).toBe(1))
    // A write notification refreshes only the outbox count: a mirror scan per
    // keystroke is exactly the hot-path regression the review warned about.
    expect(failedCount).not.toHaveBeenCalled()

    // A rejected result lands inside a sync pass, and the pass's final count
    // refresh is what moves the badge to the failed state.
    rejectNext = true
    await local!.syncNow()

    await waitFor(() =>
      expect(view.getByRole("status").textContent).toContain("۱ تغییر ذخیره نشد")
    )
    expect(failedCount).toHaveBeenCalled()
    expect(view.getByRole("status").textContent).not.toContain("همگام")

    // Pending work is a separate state: the failure label stays while a newer
    // write waits in the outbox, and that write does not rescan the mirror.
    const callsAfterAck = failedCount.mock.calls.length
    await store.writeLocal({
      entityType: "listItem",
      entityId: uuidV7(),
      op: "upsert",
      patch: { title: "در انتظار" }
    })
    await waitFor(() => expect(local!.pending()).toBe(1))
    expect(failedCount.mock.calls.length).toBe(callsAfterAck)
    expect(local!.failed()).toBe(1)
    expect(view.getByRole("status").textContent).toContain("تغییر ذخیره نشد")
    failedCount.mockRestore()
    view.unmount()
  })
})
