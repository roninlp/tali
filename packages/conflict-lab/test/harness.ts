import { exports } from "cloudflare:workers"
import { Schema } from "effect"
import { IDBFactory } from "fake-indexeddb"
import {
  SyncBootstrapResponse,
  SyncPullResponse,
  SyncPushResponse,
  type SyncEntityRow,
  type SyncEntityType,
  type SyncPushEntry,
  type SyncPushResult,
  uuidV7
} from "@tali/domain"
import { openLocalStore } from "@tali/web/src/lib/local-store/store"
import type { LocalStore, MirrorRecord } from "@tali/web/src/lib/local-store/types"
import { createSyncEngine, SyncRejected, type SyncEngine, type SyncTransport } from "@tali/web/src/lib/sync-engine"
import { api } from "@tali/web/src/lib/rpc"

/**
 * Shared plumbing for the conflict lab (#83).
 *
 * A **device** is a real `LocalStore` (its own fake-indexeddb database) plus
 * the real `createSyncEngine`, talking to the real Worker module over
 * `exports.default.fetch`. Nothing on the client path is faked except the
 * network hop itself.
 */

// ── Worker HTTP ───────────────────────────────────────────────────────────

const LOGIN_KEY = "a".repeat(43)

export const workerFetch = (
  path: string,
  init?: RequestInit
): Promise<Response> => exports.default.fetch(`http://localhost${path}`, init)

const jsonRequest = (method: string, cookie?: string, body?: unknown): RequestInit => ({
  method,
  headers: {
    "content-type": "application/json",
    ...(cookie === undefined ? {} : { cookie })
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
})

export interface Account {
  readonly userId: string
  readonly email: string
  readonly cookie: string
}

export const registerAccount = async (label = "lab"): Promise<Account> => {
  const email = `${label}-${crypto.randomUUID()}@example.com`
  const response = await workerFetch(
    "/auth/register",
    jsonRequest("POST", undefined, {
      email,
      loginKey: LOGIN_KEY,
      displayName: "آزمایش",
      timeZone: "Asia/Tehran"
    })
  )
  if (response.status !== 201) {
    throw new Error(`register failed: ${response.status} ${await response.text()}`)
  }
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("tali_session="))
    ?.split(";")[0]
  if (cookie === undefined) throw new Error("register minted no session cookie")
  const body = await response.json() as { readonly user: { readonly id: string } }
  return { userId: body.user.id, email, cookie }
}

export interface Household {
  readonly id: string
  readonly inviteCode: string
}

export const createHousehold = async (account: Account): Promise<Household> => {
  const response = await workerFetch(
    "/household",
    jsonRequest("POST", account.cookie, { name: "خانهٔ آزمایش" })
  )
  if (response.status !== 201) {
    throw new Error(`household failed: ${response.status} ${await response.text()}`)
  }
  const body = await response.json() as { readonly household: Household }
  return body.household
}

/** A second user in the same household (the partner), with a live cookie. */
export const joinHousehold = async (
  partner: Account,
  inviteCode: string
): Promise<void> => {
  const join = await workerFetch(
    "/household/join",
    jsonRequest("POST", partner.cookie, { inviteCode })
  )
  if (join.status !== 200) {
    throw new Error(`join failed: ${join.status} ${await join.text()}`)
  }
}

/** A fresh household with an owner and a partner who has already joined. */
export const freshHousehold = async (): Promise<{
  readonly owner: Account
  readonly partner: Account
  readonly householdId: string
}> => {
  const owner = await registerAccount("owner")
  const household = await createHousehold(owner)
  const partner = await registerAccount("partner")
  await joinHousehold(partner, household.inviteCode)
  return { owner, partner, householdId: household.id }
}

// ── Instrumented sync transport ───────────────────────────────────────────

export interface Telemetry {
  /** Every per-entry result the server returned, across retries. */
  readonly results: Array<SyncPushResult>
  /** Cursors returned by pulls; used to prove the client never rewinds. */
  readonly pullCursors: Array<number>
  /** Push requests, for diagnosing a failure trace. */
  pushes: number
}

export const newTelemetry = (): Telemetry => ({
  results: [],
  pullCursors: [],
  pushes: 0
})

export interface TransportOptions {
  readonly telemetry: Telemetry
  /**
   * Send every push twice with the same mutation ids — the client retrying
   * after a response was lost. The server must answer `alreadyApplied`.
   */
  duplicatePush?: boolean
}

const decodeBody = async <A>(
  response: Response,
  schema: Schema.ConstraintDecoder<A>,
  path: string
): Promise<A> => {
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const envelope = Schema.decodeUnknownOption(
      Schema.Struct({
        error: Schema.Struct({
          code: Schema.String,
          details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
        })
      })
    )(body)
    throw envelope._tag === "Some"
      ? new SyncRejected(envelope.value.error.code, envelope.value.error.details ?? {})
      : new SyncRejected(`sync-failed-${response.status}`)
  }
  if (body === undefined) throw new SyncRejected(`${path}-empty-body`)
  return Schema.decodeUnknownSync(schema)(body)
}

export const makeTransport = (
  account: Account,
  options: TransportOptions
): SyncTransport => {
  const call = async <A>(
    path: string,
    schema: Schema.ConstraintDecoder<A>,
    init: RequestInit = {}
  ): Promise<A> => {
    const response = await workerFetch(path, {
      ...init,
      headers: {
        cookie: account.cookie,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers
      }
    })
    return decodeBody(response, schema, path)
  }

  const pushOnce = async (
    entries: ReadonlyArray<SyncPushEntry>
  ): Promise<SyncPushResponse> => {
    options.telemetry.pushes += 1
    const body = JSON.stringify({ entries })
    const response = await call("/sync/push", SyncPushResponse, {
      method: "POST",
      body
    })
    options.telemetry.results.push(...response.results)
    return response
  }

  return {
    pull: async (cursor, limit) => {
      const page = await call(
        `/sync/pull?cursor=${cursor}&limit=${limit}`,
        SyncPullResponse
      )
      options.telemetry.pullCursors.push(page.nextCursor)
      return page
    },
    bootstrap: async (offset, limit) => {
      const page = await call(
        `/sync/bootstrap?offset=${offset}&limit=${limit}`,
        SyncBootstrapResponse
      )
      options.telemetry.pullCursors.push(page.cursor)
      return page
    },
    push: async (entries) => {
      if (options.duplicatePush === true) {
        await pushOnce(entries)
        return pushOnce(entries)
      }
      return pushOnce(entries)
    },
    /**
     * The two explicit repair paths the real engine uses. They are the web
     * client's Effect RPC procedures, pointed at the test Worker by `withRpc`.
     */
    logHabitEntry: (input) => withRpc(account, () => api.logHabitEntry(input)),
    restoreHabit: (input) => withRpc(account, () => api.restoreHabit(input))
  }
}

/**
 * Run the web client's Effect RPC stack against the test Worker.
 *
 * In the browser the cookie rides the session jar and the origin is the real
 * API; inside workerd neither exists. Route `globalThis.fetch` through
 * `exports.default.fetch` and add this account's session cookie.
 */
export const withRpc = async <A>(
  account: Account,
  run: () => Promise<A>
): Promise<A> => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const base = input instanceof Request ? input : new Request(input, init)
    const source = new URL(base.url)
    const headers = new Headers(base.headers)
    headers.set("cookie", account.cookie)
    const rewritten = new Request(
      `http://localhost${source.pathname}${source.search}`,
      {
        method: base.method,
        headers,
        body: base.body,
        duplex: "half"
      } as RequestInit
    )
    return exports.default.fetch(rewritten)
  }) as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

// ── Devices ───────────────────────────────────────────────────────────────

export interface Device {
  readonly label: string
  readonly account: Account
  readonly store: LocalStore
  readonly engine: SyncEngine
  readonly telemetry: Telemetry
  readonly options: TransportOptions
  /** Highest version seen per row, for monotonicity assertions. */
  readonly versions: Map<string, number>
  /** Highest cursor seen, for the never-rewind assertion. */
  readonly cursor: { value: number }
  /** Mutation ids this device has queued. */
  readonly mutationIds: Set<string>
}

let writes = 0

/** A monotonic client edit instant; the lab controls LWW inputs explicitly. */
export const tick = (): string => {
  writes += 1
  return new Date(Date.now() + writes).toISOString()
}

export const openDevice = async (
  account: Account,
  label: string
): Promise<Device> => {
  const telemetry = newTelemetry()
  const options: TransportOptions = { telemetry }
  const store = await openLocalStore(account.userId, {
    factory: new IDBFactory()
  })
  const device: Device = {
    label,
    account,
    store,
    engine: createSyncEngine(makeTransport(account, options)),
    telemetry,
    options,
    versions: new Map(),
    cursor: { value: 0 },
    mutationIds: new Set()
  }
  return device
}

// ── Reads and snapshots ───────────────────────────────────────────────────

/** Every visible live row for this account, paged to the end. */
export const serverSnapshot = async (
  account: Account
): Promise<ReadonlyArray<SyncEntityRow>> => {
  const rows: Array<SyncEntityRow> = []
  let offset = 0
  for (;;) {
    const page = await makeTransport(account, {
      telemetry: newTelemetry()
    }).bootstrap(offset, 500)
    rows.push(...page.items)
    if (!page.hasMore) return rows
    if (page.nextOffset <= offset) return rows
    offset = page.nextOffset
  }
}

export const mirrorSnapshot = async (
  store: LocalStore
): Promise<ReadonlyArray<MirrorRecord>> => {
  const rows: Array<MirrorRecord> = []
  for (const entityType of [
    "habit",
    "habitEntry",
    "event",
    "occasion",
    "task",
    "reminder",
    "note",
    "tag",
    "list",
    "listItem",
    "project"
  ] as const) {
    rows.push(...await store.list(entityType))
    rows.push(...await store.listTrashed(entityType))
  }
  return rows.sort((a, b) =>
    `${a.entityType}\u0000${a.entityId}`.localeCompare(
      `${b.entityType}\u0000${b.entityId}`
    )
  )
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`
}

const rowKey = (row: { entityType: string; entityId: string }): string =>
  `${row.entityType}\u0000${row.entityId}`

const comparable = (row: {
  entityType: string
  entityId: string
  version: number
  updatedAt: string
  deletedAt: string | null
  data: Readonly<Record<string, unknown>>
}): string =>
  canonical({
    entityType: row.entityType,
    entityId: row.entityId,
    version: row.version,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    data: row.data
  })

/**
 * Strong post-quiescence assertion: each device's live mirror is the server's
 * authoritative row **field by field**, and the two devices agree on live and
 * tombstoned rows alike.
 */
export const assertConverged = async (
  devices: ReadonlyArray<Device>,
  account: Account
): Promise<void> => {
  const server = await serverSnapshot(account)
  const serverByKey = new Map(server.map((row) => [rowKey(row), row]))
  const snapshots = new Map<string, Map<string, string>>()
  const tombstones = new Map<string, Map<string, string>>()

  for (const device of devices) {
    const pending = await device.store.pendingCount()
    if (pending !== 0) {
      throw new Error(
        `${device.label} still has ${pending} queued mutation(s) after quiescence`
      )
    }
    const mirror = await mirrorSnapshot(device.store)
    const live = new Map<string, string>()
    const trashed = new Map<string, string>()
    const seen = new Set<string>()
    for (const row of mirror) {
      const key = rowKey(row)
      if (seen.has(key)) throw new Error(`${device.label} mirror has two rows for ${key}`)
      seen.add(key)
      if (row.deletedAt !== null) {
        if (serverByKey.has(key)) {
          throw new Error(`${device.label} shows ${key} as deleted but the server has it live`)
        }
        trashed.set(key, canonical(row))
        continue
      }
      const authoritative = serverByKey.get(key)
      if (authoritative === undefined) {
        throw new Error(`${device.label} holds ${key}, which the server does not expose`)
      }
      if (comparable(row) !== comparable(authoritative)) {
        throw new Error(
          `${device.label} diverged on ${key}\n` +
            `  mirror: ${comparable(row)}\n` +
            `  server: ${comparable(authoritative)}`
        )
      }
      live.set(key, comparable(row))
    }
    for (const key of serverByKey.keys()) {
      if (!live.has(key)) {
        throw new Error(`${device.label} is missing live server row ${key}`)
      }
    }
    snapshots.set(device.label, live)
    tombstones.set(device.label, trashed)
  }

  const [first, ...rest] = devices
  if (first === undefined) return
  const reference = snapshots.get(first.label)!
  const referenceTrash = tombstones.get(first.label)!
  for (const device of rest) {
    const rows = snapshots.get(device.label)!
    for (const [key, value] of reference) {
      if (rows.get(key) !== value) {
        throw new Error(
          `${first.label} and ${device.label} disagree on ${key}\n` +
            `  ${first.label}: ${value}\n` +
            `  ${device.label}: ${rows.get(key) ?? "<missing>"}`
        )
      }
    }
    const trash = tombstones.get(device.label)!
    for (const [key, value] of referenceTrash) {
      if (trash.get(key) !== value) {
        throw new Error(
          `${first.label} and ${device.label} disagree on tombstone ${key}\n` +
            `  ${first.label}: ${value}\n` +
            `  ${device.label}: ${trash.get(key) ?? "<missing>"}`
        )
      }
    }
    for (const key of trash.keys()) {
      if (!referenceTrash.has(key)) {
        throw new Error(
          `${device.label} holds tombstone ${key}, which ${first.label} does not`
        )
      }
    }
  }
}

/**
 * Record version/cursor monotonicity after a pass. Called at the end of every
 * sync so a rewind or a decreased version is attributed to the step that
 * caused it.
 */
export const observeMonotonicity = async (device: Device): Promise<void> => {
  const cursor = await device.store.cursor()
  if (cursor < device.cursor.value) {
    throw new Error(
      `${device.label} cursor rewound: ${device.cursor.value} -> ${cursor}`
    )
  }
  device.cursor.value = cursor
  const rows = await mirrorSnapshot(device.store)
  for (const row of rows) {
    const key = rowKey(row)
    const previous = device.versions.get(key)
    if (previous !== undefined && row.version < previous) {
      throw new Error(
        `${device.label} version rewound on ${key}: ${previous} -> ${row.version}`
      )
    }
    device.versions.set(key, row.version)
  }
}

/**
 * Sync one device, treating a retryable contention as a normal step outcome.
 * Returns `true` when the pass completed, `false` when it must be retried.
 */
export const syncDevice = async (device: Device): Promise<boolean> => {
  try {
    await device.engine.sync(device.store)
    await observeMonotonicity(device)
    return true
  } catch (cause) {
    if (cause instanceof SyncRejected && cause.code === "Conflict") {
      await observeMonotonicity(device)
      return false
    }
    throw cause
  }
}

/** Both devices sync at once, forcing real interleaving inside the Worker. */
export const syncConcurrently = async (
  devices: ReadonlyArray<Device>
): Promise<boolean> => {
  const outcomes = await Promise.all(devices.map((device) =>
    syncDevice(device).catch((cause: unknown) => {
      throw cause
    })
  ))
  return outcomes.every(Boolean)
}

/**
 * Drive both devices to quiescence. Pulls propagate in one round and pushes in
 * the same pass, so a handful of rounds is enough; a real 409 contention needs
 * one extra round.
 */
export const settle = async (
  devices: ReadonlyArray<Device>,
  rounds = 12
): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    let activity = false
    for (const device of devices) {
      const cursorBefore = await device.store.cursor()
      const pushesBefore = device.telemetry.pushes
      const completed = await syncDevice(device)
      const cursorAfter = await device.store.cursor()
      if (
        !completed ||
        cursorAfter !== cursorBefore ||
        device.telemetry.pushes !== pushesBefore
      ) {
        activity = true
      }
    }
    if (!activity) {
      const pending = await Promise.all(
        devices.map(async (device) => `${device.label}:${await device.store.pendingCount()}`)
      )
      if (pending.every((value) => value.endsWith(":0"))) return
      throw new Error(`quiescent but not drained (${pending.join(", ")})`)
    }
  }
  const pending = await Promise.all(
    devices.map(async (device) => `${device.label}:${await device.store.pendingCount()}`)
  )
  throw new Error(`did not settle after ${rounds} rounds (${pending.join(", ")})`)
}

// ── Local writes ──────────────────────────────────────────────────────────

export interface QueuedWrite {
  readonly entityType: SyncEntityType
  readonly entityId: string
  readonly op: "upsert" | "delete"
  readonly patch: Readonly<Record<string, unknown>>
  /** Explicit LWW/edit instant, so a race test never depends on the clock. */
  readonly now?: string
}

/**
 * Queue one mutation with an explicit id so the lab can prove every queued
 * mutation came back acked.
 */
export const queueWrite = async (
  device: Device,
  write: QueuedWrite,
  clientMutationId = uuidV7()
): Promise<string> => {
  device.mutationIds.add(clientMutationId)
  const { now, ...rest } = write
  await device.store.writeLocal({
    ...rest,
    clientMutationId,
    ...(now === undefined ? {} : { now })
  })
  return clientMutationId
}
