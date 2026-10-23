import { env } from "cloudflare:workers"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { uuidV7 } from "@tali/domain"
import {
  assertAcknowledgements,
  assertConverged,
  createHousehold,
  LAB_MODE,
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
import { resolveLabMode } from "./mode"
import {
  decodeWriteToken,
  TOKEN,
  TOKEN_COUNT,
  WRITE_TOKEN_COUNT,
  type WriteKind
} from "./program"

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

/**
 * Injected by `vitest.config.ts` (workerd cannot read `process.env`). The
 * mode test below fails if the injection stops tracking the CLI flag.
 */
const NUM_RUNS = LAB_MODE.numRuns
const MAX_STEPS = LAB_MODE.maxSteps

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
  kind: WriteKind,
  step: number,
  run: string
): Promise<void> => {
  const current = await device.store.get(slot.entityType, slot.id)

  if (kind === 2) {
    await queueWrite(
      device,
      { entityType: slot.entityType, entityId: slot.id, op: "delete", patch: {} },
      `${run}-${device.label}-${step}-delete`
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
      `${run}-${device.label}-${step}-revive`
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
    `${run}-${device.label}-${step}-write`
  )
}

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
  step: number,
  run: string
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
    `${run}-probe${step}-create`
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
    `${run}-probe${step}-title`
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
    `${run}-probe${step}-priority`
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
  step: number,
  run: string
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
    `${run}-lww${step}-create`
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
    `${run}-lww${step}-newer`
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
    `${run}-lww${step}-older`
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
  // `applied_mutations` is keyed only by `clientMutationId`, so ids must be
  // unique across *every* fast-check run, not just within one program.
  const run = uuidV7()
  let disjointProbes = 0
  let lwwProbes = 0
  for (let step = 0; step < tokens.length; step += 1) {
    const token = tokens[step]!
    if (token < WRITE_TOKEN_COUNT) {
      const write = decodeWriteToken(token)
      await writeToken(devices[write.device], slots[write.slot]!, write.kind, step, run)
      continue
    }
    switch (token) {
      case TOKEN.syncA:
        await syncDevice(devices[0])
        break
      case TOKEN.syncB:
        await syncDevice(devices[1])
        break
      case TOKEN.concurrentSync:
        await syncConcurrently(devices)
        break
      case TOKEN.duplicatePushA:
      case TOKEN.duplicatePushB: {
        const device = devices[token === TOKEN.duplicatePushA ? 0 : 1]
        device.options.duplicatePush = true
        try {
          await syncDevice(device)
        } finally {
          device.options.duplicatePush = false
        }
        break
      }
      case TOKEN.disjointProbe:
        if (disjointProbes < 3) {
          disjointProbes += 1
          probes.push(await runDisjointProbe(devices, step, run))
        }
        break
      case TOKEN.lwwProbe:
        if (lwwProbes < 3) {
          lwwProbes += 1
          probes.push(await runLwwProbe(devices, step, run))
        }
        break
      default:
        throw new Error(`unknown token ${token}`)
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

describe("two-device convergence", () => {
  it("converges over arbitrary interleavings of writes, pulls and pushes", async () => {
    // The run length must follow the CLI flag, not a `process.env` read that
    // workerd cannot see (that silently made nightly == PR CI).
    expect(LAB_MODE).toEqual(resolveLabMode(env.CONFLICT_LAB_NIGHTLY))
    expect(NUM_RUNS).toBe(LAB_MODE.nightly ? 100 : 20)
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
