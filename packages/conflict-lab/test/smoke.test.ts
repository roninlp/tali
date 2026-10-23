import { IDBFactory } from "fake-indexeddb"
import { describe, expect, it } from "vitest"
import { uuidV7 } from "@tali/domain"
import { openLocalStore } from "@tali/web/src/lib/local-store/store"
import { createSyncEngine } from "@tali/web/src/lib/sync-engine"
import {
  createHousehold,
  makeTransport,
  newTelemetry,
  registerAccount
} from "./harness"

/**
 * Environment smoke test: the real client engine (LocalStore over
 * fake-indexeddb + the real sync engine) running inside workerd against the
 * real Worker module. If this fails, nothing else in the lab is meaningful.
 */
describe("conflict lab environment", () => {
  it("drives the real client engine against the real Worker", async () => {
    const account = await registerAccount("smoke")
    await createHousehold(account)

    const store = await openLocalStore(account.userId, {
      factory: new IDBFactory()
    })
    const engine = createSyncEngine(
      makeTransport(account, { telemetry: newTelemetry() })
    )
    const taskId = uuidV7()

    await store.writeLocal({
      entityType: "task",
      entityId: taskId,
      op: "upsert",
      patch: { title: "اولین کار" }
    })
    await engine.sync(store)

    expect(await store.pending()).toHaveLength(0)
    const row = await store.get("task", taskId)
    expect(row).toMatchObject({ version: 1, deletedAt: null })
    expect(row?.data.title).toBe("اولین کار")

    store.close()
  })
})
