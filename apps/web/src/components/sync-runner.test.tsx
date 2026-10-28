import "fake-indexeddb/auto"
import { onSettled } from "solid-js"
import { render } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { uuidV7, type SessionContext } from "@tali/domain"
import { AuthProvider } from "../lib/auth"
import {
  LocalStoreProvider,
  useLocalStore,
  type LocalStoreContextValue
} from "../lib/local-store"
import { ACTIVE_INTERVAL_MS } from "../lib/sync-cadence"
import { SyncRunner } from "./sync-runner"

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

/** Let real microtasks and fake-indexeddb's real `setImmediate` run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function Probe(props: { readonly onValue: (value: LocalStoreContextValue) => void }) {
  const local = useLocalStore()
  onSettled(() => props.onValue(local))
  return null
}

describe("SyncRunner", () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible"
    })
    stubServer()
    // Only the cadence clock is faked; fake-indexeddb needs the real
    // setImmediate, and testing-library's waitFor is not used here.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("wakes immediately on a local write and returns to the fast cadence", async () => {
    let local: LocalStoreContextValue | undefined
    let calls = 0
    const view = render(() => (
      <AuthProvider>
        <LocalStoreProvider>
          <SyncRunner
            handler={async () => {
              calls += 1
            }}
          />
          <Probe
            onValue={(value) => {
              local = value
            }}
          />
        </LocalStoreProvider>
      </AuthProvider>
    ))

    for (let i = 0; i < 50 && local?.status() !== "ready"; i += 1) await settle()
    expect(local?.status()).toBe("ready")

    // The loop starts with an immediate pass.
    await settle()
    expect(calls).toBeGreaterThanOrEqual(1)

    // The healthy cadence is 3.5 s.
    const afterStart = calls
    await vi.advanceTimersByTimeAsync(ACTIVE_INTERVAL_MS)
    await settle()
    expect(calls).toBe(afterStart + 1)

    // A local write wakes a pass without waiting for the timer. Pending never
    // drains because the fake handler does not ack, so the wake is one write.
    const beforeWrite = calls
    await local!.store()!.writeLocal({
      entityType: "listItem",
      entityId: uuidV7(),
      op: "upsert",
      patch: { title: "نان" }
    })
    await settle()
    expect(calls).toBe(beforeWrite + 1)

    // That write is activity again: the next pass is the fast one.
    const afterWrite = calls
    await vi.advanceTimersByTimeAsync(ACTIVE_INTERVAL_MS - 1)
    await settle()
    expect(calls).toBe(afterWrite)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(calls).toBe(afterWrite + 1)

    view.unmount()
  })
})
