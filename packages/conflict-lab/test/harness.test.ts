import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import type { SyncPushResult } from "@tali/domain"
import {
  assertAcknowledgements,
  assertCursorsNonDecreasing,
  LAB_MODE,
  newTelemetry,
  withRpc,
  type Account,
  type AckSource
} from "./harness"
import { resolveLabMode } from "./mode"
import { decodeWriteToken, SLOT_COUNT, WRITE_TOKEN_COUNT } from "./program"

/**
 * Unit tests for the harness itself.
 *
 * These pin the things a convergence test cannot observe about its own
 * machinery: that the nightly flag actually reaches workerd, that the
 * generator's alphabet still contains deletes and revives, that the ack
 * assertion rejects a double-executed replay, and that overlapping RPC calls
 * restore the global `fetch`.
 */

const account = (userId: string): Account => ({
  userId,
  email: `${userId}@example.com`,
  cookie: `tali_session=${userId}`
})

const result = (
  tag: SyncPushResult["_tag"],
  clientMutationId: string,
  code = "UniqueViolation"
): SyncPushResult =>
  (tag === "rejected"
    ? {
        _tag: tag,
        clientMutationId,
        entityType: "task",
        entityId: "entity",
        code,
        message: "synthetic"
      }
    : {
        _tag: tag,
        clientMutationId,
        entityType: "task",
        entityId: "entity",
        version: 1,
        seq: 1
      }) as SyncPushResult

const ackSource = (results: ReadonlyArray<SyncPushResult>): AckSource => {
  const telemetry = newTelemetry()
  telemetry.results.push(...results)
  return {
    label: "A",
    mutationIds: new Set(results.map((entry) => entry.clientMutationId)),
    telemetry
  }
}

describe("conflict lab harness", () => {
  it("carries the nightly flag into the worker", () => {
    expect(LAB_MODE).toEqual(resolveLabMode(env.CONFLICT_LAB_NIGHTLY))
    expect(resolveLabMode("1").numRuns).toBeGreaterThan(resolveLabMode(undefined).numRuns)
    expect(resolveLabMode("1").maxSteps).toBeGreaterThan(resolveLabMode(undefined).maxSteps)
  })

  it("generates every write kind, both devices and every slot", () => {
    const kinds = new Set<number>()
    const devices = new Set<number>()
    const slots = new Set<number>()
    for (let token = 0; token < WRITE_TOKEN_COUNT; token += 1) {
      const decoded = decodeWriteToken(token)
      kinds.add(decoded.kind)
      devices.add(decoded.device)
      slots.add(decoded.slot)
    }
    // The regression this pins: 12 tokens per device over 6 slots only ever
    // produced kinds 0 and 1, so deletes and revives were never generated.
    expect([...kinds].sort()).toEqual([0, 1, 2, 3])
    expect([...devices].sort()).toEqual([0, 1])
    expect(slots.size).toBe(SLOT_COUNT)
  })

  it("accepts exactly-once replay but rejects a re-executed mutation", () => {
    expect(() => assertAcknowledgements([
      ackSource([result("applied", "m"), result("alreadyApplied", "m")])
    ])).not.toThrow()
    // The shapes a broken `applied_mutations` dedupe produces: a replayed
    // create comes back as a second rejection, a replayed edit as a conflict.
    expect(() => assertAcknowledgements([
      ackSource([result("applied", "m"), result("rejected", "m")])
    ])).toThrow(/re-executed/)
    expect(() => assertAcknowledgements([
      ackSource([result("applied", "m"), result("conflict", "m")])
    ])).toThrow(/re-executed/)
  })

  it("accepts the documented create-create race and rejects a lost ack", () => {
    expect(() => assertAcknowledgements([
      ackSource([result("rejected", "m")])
    ])).not.toThrow()
    // Queued but never answered.
    expect(() => assertAcknowledgements([{
      label: "A",
      mutationIds: new Set(["m"]),
      telemetry: newTelemetry()
    }])).toThrow(/lost the ack/)
  })

  it("rejects a cursor that moves backwards", () => {
    expect(() => assertCursorsNonDecreasing("A", [1, 4, 3])).toThrow(/rewound/)
    expect(() => assertCursorsNonDecreasing("A", [1, 4, 4])).not.toThrow()
  })

  it("restores the original fetch after overlapping RPC calls", async () => {
    const original = globalThis.fetch
    const delay = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, 5))
    const values = await Promise.all([
      withRpc(account("a"), async () => {
        await delay()
        return "a"
      }),
      withRpc(account("b"), async () => {
        await delay()
        return "b"
      })
    ])
    expect(values).toEqual(["a", "b"])
    expect(globalThis.fetch).toBe(original)
  })
})
