import { describe, expect, it, vi } from "vitest"
import { coalesceMicrotask } from "./coalesce"

describe("coalesceMicrotask", () => {
  it("runs once for a burst in the same tick and again on the next tick", async () => {
    const task = vi.fn()
    const schedule = coalesceMicrotask(task)

    schedule()
    schedule()
    schedule()
    await Promise.resolve()
    expect(task).toHaveBeenCalledTimes(1)

    schedule()
    await Promise.resolve()
    expect(task).toHaveBeenCalledTimes(2)
  })
})
