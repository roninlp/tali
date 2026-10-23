import fc from "fast-check"
import { describe, it } from "vitest"
import { uuidV7 } from "@tali/domain"
import {
  assertConverged,
  createHousehold,
  openDevice,
  queueWrite,
  registerAccount,
  serverSnapshot,
  settle,
  syncConcurrently,
  syncDevice,
  type Account,
  type Device
} from "./harness"

/**
 * The conflict simulator (ticket #83 / the #81 verification strategy).
 *
 * `fast-check` generates a two-device trace over the sync registry's
 * aggregates: creates, field edits, deletes, delete-then-edit "revives",
 * per-device syncs, and concurrent syncs (the real CAS interleaving). Each
 * device is the production `LocalStore` + `createSyncEngine`; the server is
 * the production Worker. Shrinking therefore reduces a failure to a minimal
 * sequence of real device actions.
 */

const nightly = process.env.CONFLICT_LAB_NIGHTLY === "1"

/** Bounded for PR CI; the nightly run explores five times as much. */
const NUM_RUNS = nightly ? 100 : 20
const MAX_STEPS = nightly ? 45 : 30

type EntityType = "task" | "listItem" | "note"

/** A fixed pool of rows the two devices can address. */
interface Slot {
  readonly entityType: EntityType
  readonly id: string
}

const makeSlots = (): ReadonlyArray<Slot> => [
  { entityType: "task", id: uuidV7() },
  { entityType: "task", id: uuidV7() },
  { entityType: "listItem", id: uuidV7() },
  { entityType: "listItem", id: uuidV7() },
  { entityType: "note", id: uuidV7() },
  { entityType: "note", id: uuidV7() }
]

const title = (step: number): string => `عنوان-${step}`

/**
 * One write token. The op is interpreted against the device's current mirror:
 * a missing row becomes a create, a deleted row becomes a revive attempt
 * (which the generic resolver must refuse), a live row becomes a field edit.
 */
const writeToken = async (
  device: Device,
  slot: Slot,
  kind: 0 | 1 | 2 | 3,
  step: number
): Promise<void> => {
  const current = await device.store.get(slot.entityType, slot.id)

  if (kind === 2) {
    await queueWrite(
      device,
      { entityType: slot.entityType, entityId: slot.id, op: "delete", patch: {} },
      `${device.label}-${step}-delete`
    )
    return
  }

  if (kind === 3 && current !== undefined && current.deletedAt !== null) {
    // An offline "undo" of a delete: the generic resolver keeps tombstones
    // winning, so both mirrors must converge *on the tombstone*.
    await queueWrite(
      device,
      {
        entityType: slot.entityType,
        entityId: slot.id,
        op: "upsert",
        patch: { title: title(step) }
      },
      `${device.label}-${step}-revive`
    )
    return
  }

  const patch = ((): Record<string, unknown> => {
    if (current === undefined || current.deletedAt !== null) {
      return { title: title(step) }
    }
    const choice = step % 3
    switch (slot.entityType) {
      case "task":
        return choice === 0
          ? { title: title(step) }
          : choice === 1
          ? { status: step % 2 === 0 ? "done" : "todo" }
          : { priority: step % 2 === 0 ? "high" : "low" }
      case "listItem":
        return choice === 0
          ? { title: title(step) }
          : choice === 1
          ? { checked: step % 2 === 0 }
          : { sortOrder: step }
      case "note":
        return choice === 0
          ? { title: title(step) }
          : choice === 1
          ? { plainText: `متن-${step}` }
          : { isPinned: step % 2 === 0 }
    }
  })()

  await queueWrite(
    device,
    { entityType: slot.entityType, entityId: slot.id, op: "upsert", patch },
    `${device.label}-${step}-write`
  )
}

/** The token alphabet: 24 writes (12 per device), 5 sync flavours, 2 probes. */
const TOKEN_COUNT = 31

/** An edit instant relative to the lab's real clock. */
const future = (offsetMs: number): string =>
  new Date(Date.now() + 60_000 + offsetMs).toISOString()
const past = (offsetMs: number): string =>
  new Date(Date.now() - 60_000 + offsetMs).toISOString()

interface Probe {
  readonly id: string
  readonly field: "title" | "priority"
  readonly expected: string
}

/**
 * Two devices write **disjoint fields** from the same base version, then sync
 * concurrently. Field-level LWW must keep both writes; a resolver that
 * clobbers the row with one patch loses one of them.
 */
const runDisjointProbe = async (
  devices: readonly [Device, Device],
  step: number
): Promise<Probe> => {
  const id = uuidV7()
  const expectedTitle = `probe-a-${step}`
  await queueWrite(
    devices[0],
    {
      entityType: "task",
      entityId: id,
      op: "upsert",
      patch: { title: "probe", priority: "medium" },
      now: future(0)
    },
    `probe${step}-create`
  )
  await syncDevice(devices[0])
  await syncDevice(devices[1])

  await queueWrite(
    devices[0],
    {
      entityType: "task",
      entityId: id,
      op: "upsert",
      patch: { title: expectedTitle },
      now: future(10_000)
    },
    `probe${step}-title`
  )
  await queueWrite(
    devices[1],
    {
      entityType: "task",
      entityId: id,
      op: "upsert",
      patch: { priority: "high" },
      now: future(11_000)
    },
    `probe${step}-priority`
  )
  await syncConcurrently(devices)
  return { id, field: "title", expected: expectedTitle }
}

/**
 * Two devices write the **same field**, and the older edit reaches the server
 * last. LWW by `clientUpdatedAt` must keep the newer value; a "last push wins"
 * resolver takes the older one.
 */
const runLwwProbe = async (
  devices: readonly [Device, Device],
  step: number
): Promise<Probe> => {
  const id = uuidV7()
  const newer = `lww-newer-${step}`
  await queueWrite(
    devices[0],
    {
      entityType: "task",
      entityId: id,
      op: "upsert",
      patch: { title: "base" },
      now: future(0)
    },
    `lww${step}-create`
  )
  await syncDevice(devices[0])
  await syncDevice(devices[1])

  // The newer edit is written and pushed first; the older edit arrives last
  // with a stale anchor and an older `clientUpdatedAt`.
  await queueWrite(
    devices[0],
    {
      entityType: "task",
      entityId: id,
      op: "upsert",
      patch: { title: newer },
      now: future(10_000)
    },
    `lww${step}-newer`
  )
  // Land the newer edit before the older one is even written.
  await settle([devices[0]])
  await queueWrite(
    devices[1],
    {
      entityType: "task",
      entityId: id,
      op: "upsert",
      patch: { title: `lww-older-${step}` },
      now: past(0)
    },
    `lww${step}-older`
  )
  await settle([devices[1]])
  return { id, field: "title", expected: newer }
}

const runProgram = async (
  devices: readonly [Device, Device],
  slots: ReadonlyArray<Slot>,
  tokens: ReadonlyArray<number>
): Promise<ReadonlyArray<Probe>> => {
  const probes: Array<Probe> = []
  let disjointProbes = 0
  let lwwProbes = 0
  for (let step = 0; step < tokens.length; step += 1) {
    const token = tokens[step]!
    if (token < 24) {
      const device = devices[token < 12 ? 0 : 1]
      const local = token % 12
      const slot = slots[local % slots.length]!
      const kind = Math.floor(local / slots.length) as 0 | 1 | 2 | 3
      await writeToken(device, slot, kind, step)
      continue
    }
    if (token === 24) {
      await syncDevice(devices[0])
      continue
    }
    if (token === 25) {
      await syncDevice(devices[1])
      continue
    }
    if (token === 26) {
      await syncConcurrently(devices)
      continue
    }
    if (token === 27 || token === 28) {
      const device = devices[token === 27 ? 0 : 1]
      device.options.duplicatePush = true
      try {
        await syncDevice(device)
      } finally {
        device.options.duplicatePush = false
      }
      continue
    }
    if (token === 29 && disjointProbes < 3) {
      disjointProbes += 1
      probes.push(await runDisjointProbe(devices, step))
      continue
    }
    if (token === 30 && lwwProbes < 3) {
      lwwProbes += 1
      probes.push(await runLwwProbe(devices, step))
    }
  }
  return probes
}

/** The probes are semantic oracles: convergence alone cannot catch a clobber. */
const assertProbes = async (
  probes: ReadonlyArray<Probe>,
  account: Account
): Promise<void> => {
  if (probes.length === 0) return
  const rows = new Map(
    (await serverSnapshot(account)).map((row) => [row.entityId, row])
  )
  for (const probe of probes) {
    const row = rows.get(probe.id)
    if (row === undefined) {
      throw new Error(`probe row ${probe.id} is missing from the server`)
    }
    const actual = row.data[probe.field]
    if (actual !== probe.expected) {
      throw new Error(
        `probe ${probe.id} expected ${probe.field}=${probe.expected}, got ${String(actual)}`
      )
    }
    if (probe.field === "title") {
      const priority = row.data.priority
      // The disjoint probe also requires the *other* device's field to survive.
      if (probe.expected.startsWith("probe-a-") && priority !== "high") {
        throw new Error(
          `probe ${probe.id} lost the concurrent priority write (got ${String(priority)})`
        )
      }
    }
  }
}

/**
 * Every queued mutation came back resolved, and no mutation applied twice.
 *
 * `conflict` and `tombstone` are legitimate resolutions (a no-op field merge
 * and a delete-wins refusal); `alreadyApplied` is the duplicate-push path.
 * The only accepted `rejected` is the documented create-create race: two
 * devices insert the same new id concurrently, the loser's INSERT no-ops, and
 * it converges by pull. Any other rejection is a generator or product bug.
 */
const assertAcknowledgements = (devices: ReadonlyArray<Device>): void => {
  for (const device of devices) {
    const resultsById = new Map<string, Array<{ tag: string; code?: string }>>()
    for (const result of device.telemetry.results) {
      const tags = resultsById.get(result.clientMutationId) ?? []
      tags.push({
        tag: result._tag,
        ...(result._tag === "rejected" ? { code: result.code } : {})
      })
      resultsById.set(result.clientMutationId, tags)
    }
    for (const id of device.mutationIds) {
      const results = resultsById.get(id)
      if (results === undefined) {
        throw new Error(`${device.label} lost the ack for ${id}`)
      }
      const applied = results.filter((result) => result.tag === "applied").length
      if (applied > 1) {
        throw new Error(`${device.label} applied ${id} ${applied} times`)
      }
      const unresolved = results.every(
        (result) => result.tag === "rejected" && result.code !== "UniqueViolation"
      )
      if (unresolved) {
        throw new Error(
          `${device.label} did not resolve ${id}: ${results.map((result) => `${result.tag}${result.code === undefined ? "" : `/${result.code}`}`).join(",")}`
        )
      }
    }
    for (const id of resultsById.keys()) {
      if (!device.mutationIds.has(id)) {
        throw new Error(`${device.label} saw an unknown mutation id ${id}`)
      }
    }
  }
}

describe("two-device convergence", () => {
  it("converges over arbitrary interleavings of writes, pulls and pushes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: TOKEN_COUNT - 1 }), {
          minLength: 1,
          maxLength: MAX_STEPS
        }),
        async (tokens) => {
          const account = await registerAccount("sim")
          await createHousehold(account)
          const devices: readonly [Device, Device] = [
            await openDevice(account, "A"),
            await openDevice(account, "B")
          ]
          try {
            const probes = await runProgram(devices, makeSlots(), tokens)
            await settle(devices)
            assertAcknowledgements(devices)
            await assertConverged(devices, account)
            await assertProbes(probes, account)
          } finally {
            for (const device of devices) device.store.close()
          }
        }
      ),
      {
        numRuns: NUM_RUNS,
        endOnFailure: true,
        verbose: true
      }
    )
  })
})
