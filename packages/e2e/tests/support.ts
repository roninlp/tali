import {
  expect,
  request,
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type TestInfo
} from "@playwright/test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Shared harness for the five gate flows (#84): seeded identities, client-side
 * ids, Tehran calendar arithmetic and the two HTTP shapes the flows seed
 * through (`/sync/push`, the reminder inbox).
 */

export const WEB_URL = "http://localhost:3000"
export const API_URL = "http://localhost:8787"

/** The session cookie minted by `/auth/register` (auth-routes.ts). */
export const SESSION_COOKIE = "tali_session"

/** The Alchemy stage `scripts/stack.mjs` boots and the seed project fills. */
export const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".state")

export interface SeededPeople {
  readonly householdId: string
  readonly inviteCode: string
  readonly alice: { readonly userId: string; readonly email: string; readonly storageState: string }
  readonly bob: { readonly userId: string; readonly email: string; readonly storageState: string }
  readonly runTag: string
}

/** The seed project's output — identities, the household and the run tag. */
export const readSeed = (): SeededPeople =>
  JSON.parse(readFileSync(join(STATE_DIR, "seed.json"), "utf8")) as SeededPeople

// ── Ids ────────────────────────────────────────────────────────────────────

const HEX = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, "0"))

/**
 * UUID v7, the client-mintable id the domain requires (`packages/domain/src/ids.ts`).
 * Not a v4: the server's registry rejects an id whose version nibble is wrong
 * with `InvalidPatch`, which is exactly what an E2E seed would otherwise hit.
 */
export const uuidV7 = (now: number = Date.now()): string => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const timestamp = BigInt(Math.max(0, Math.trunc(now)))
  bytes[0] = Number((timestamp >> 40n) & 0xffn)
  bytes[1] = Number((timestamp >> 32n) & 0xffn)
  bytes[2] = Number((timestamp >> 24n) & 0xffn)
  bytes[3] = Number((timestamp >> 16n) & 0xffn)
  bytes[4] = Number((timestamp >> 8n) & 0xffn)
  bytes[5] = Number(timestamp & 0xffn)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  return (
    HEX[bytes[0]!]! + HEX[bytes[1]!]! + HEX[bytes[2]!]! + HEX[bytes[3]!]! +
    "-" + HEX[bytes[4]!]! + HEX[bytes[5]!]! +
    "-" + HEX[bytes[6]!]! + HEX[bytes[7]!]! +
    "-" + HEX[bytes[8]!]! + HEX[bytes[9]!]! +
    "-" + HEX[bytes[10]!]! + HEX[bytes[11]!]! + HEX[bytes[12]!]! +
    HEX[bytes[13]!]! + HEX[bytes[14]!]! + HEX[bytes[15]!]!
  )
}

/** Per-run suffix: the same D1 can carry a previous run's rows. */
export const uniqueTag = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

// ── Tehran dates ───────────────────────────────────────────────────────────

/** Today's date in the account's zone, as `YYYY-MM-DD`. */
export const tehranToday = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now)

/** Plain calendar-day arithmetic on a `YYYY-MM-DD` string. */
export const addDays = (date: string, days: number): string => {
  const [year, month, day] = date.split("-").map(Number)
  const value = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1))
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

/** ISO weekday: Monday = 1 … Sunday = 7 (the recurrence rule's numbering). */
export const isoWeekday = (date: string): number => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay()
  return day === 0 ? 7 : day
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

/** An API client carrying one seeded user's session cookie. */
export const apiFor = (storageState: string): Promise<APIRequestContext> =>
  request.newContext({ baseURL: API_URL, storageState })

export interface PushResult {
  readonly _tag: string
  readonly entityId: string
  readonly version: number
  readonly item?: { readonly data?: Record<string, unknown> }
  readonly message?: string
}

/**
 * Push one mutation through the real offline-first transport and require it to
 * land. `InvalidPatch` here means the seeded shape drifted from the registry.
 */
export const pushApplied = async (
  api: APIRequestContext,
  entry: {
    readonly entityType: string
    readonly entityId: string
    readonly patch: Record<string, unknown>
    readonly baseVersion?: number
  }
): Promise<PushResult> => {
  const response = await api.post("/sync/push", {
    data: {
      entries: [
        {
          clientMutationId: uuidV7(),
          entityType: entry.entityType,
          entityId: entry.entityId,
          baseVersion: entry.baseVersion ?? 0,
          op: "upsert",
          clientUpdatedAt: new Date().toISOString(),
          patch: entry.patch
        }
      ]
    }
  })
  expect(response.ok(), `push ${entry.entityType} → ${response.status()}`).toBeTruthy()
  const body = (await response.json()) as { results: PushResult[] }
  const result = body.results[0]
  expect(result, `push ${entry.entityType} returned no result`).toBeDefined()
  expect(
    result!._tag,
    `push ${entry.entityType} was ${result!._tag}: ${result!.message ?? ""}`
  ).toBe("applied")
  return result!
}

/** Every live row this household can see, following `hasMore`. */
export const pullAll = async (
  api: APIRequestContext
): Promise<
  ReadonlyArray<{
    entityType: string
    entityId: string
    version: number
    data: Record<string, unknown>
  }>
> => {
  const rows: Array<{
    entityType: string
    entityId: string
    version: number
    data: Record<string, unknown>
  }> = []
  let cursor = 0
  for (;;) {
    const response = await api.get(`/sync/pull?cursor=${cursor}&limit=500`)
    expect(response.ok(), `pull → ${response.status()}`).toBeTruthy()
    const body = (await response.json()) as {
      items: Array<{
        entityType: string
        entityId: string
        version: number
        data: Record<string, unknown>
      }>
      nextCursor: number
      hasMore: boolean
    }
    rows.push(...body.items)
    if (!body.hasMore) return rows
    cursor = body.nextCursor
  }
}

/** The reminder ledger rows `/reminders` is rendering. */
export const inboxItems = async (
  api: APIRequestContext,
  history = false
): Promise<
  ReadonlyArray<{
    dispatch: { id: string; response: string | null }
    title: string
    kind: string
  }>
> => {
  const response = await api.get(`/reminders/inbox${history ? "?history=1" : ""}`)
  expect(response.ok(), `inbox → ${response.status()}`).toBeTruthy()
  const body = (await response.json()) as {
    items: Array<{ dispatch: { id: string; response: string | null }; title: string; kind: string }>
  }
  return body.items
}

/** Trigger the dev-only catch-up sweep (`alchemy dev` runs no crons). */
export const sweepReminders = async (
  api: APIRequestContext,
  at: Date = new Date()
): Promise<{ claimed: number; pushed: number; expired: number }> => {
  const response = await api.post(`/dev/reminders/sweep?at=${encodeURIComponent(at.toISOString())}`)
  expect(response.ok(), `sweep → ${response.status()}`).toBeTruthy()
  return (await response.json()) as { claimed: number; pushed: number; expired: number }
}

/** The sync-status pill lives in the app header; its text is the sync truth. */
export const syncStatus = (page: Page) => page.locator("header span[role='status']")

/** Attach the ids a flow created, so a failure leaves the seeded state (#84). */
export const attachSeed = async (testInfo: TestInfo, seed: Record<string, unknown>) => {
  await testInfo.attach("seeded-state.json", {
    body: JSON.stringify(seed, null, 2),
    contentType: "application/json"
  })
}

// ── Fixtures ───────────────────────────────────────────────────────────────

export interface GateFixtures {
  readonly alice: BrowserContext
  readonly bob: BrowserContext
  readonly alicePage: Page
  readonly bobPage: Page
  readonly aliceApi: APIRequestContext
  readonly bobApi: APIRequestContext
  /** The two seeded identities, for tests that need ids (never mutable). */
  readonly people: SeededPeople
}

/**
 * Two devices, one household, one database (#81).
 *
 * `alice` is the household's creator and `bob` joined by invite in the seed
 * project. Each context boots from its own Playwright storage state, so a flow
 * starts signed in without replaying registration — except flow 1, which is
 * about registration and builds its own users.
 */
export const test = base.extend<GateFixtures>({
  people: async ({}, use) => {
    await use(readSeed())
  },
  alice: async ({ browser, people }, use) => {
    const context = await browser.newContext({ storageState: people.alice.storageState })
    await use(context)
    await context.close()
  },
  bob: async ({ browser, people }, use) => {
    const context = await browser.newContext({ storageState: people.bob.storageState })
    await use(context)
    await context.close()
  },
  alicePage: async ({ alice }, use) => {
    await use(await alice.newPage())
  },
  bobPage: async ({ bob }, use) => {
    await use(await bob.newPage())
  },
  aliceApi: async ({ people }, use) => {
    const api = await apiFor(people.alice.storageState)
    await use(api)
    await api.dispose()
  },
  bobApi: async ({ people }, use) => {
    const api = await apiFor(people.bob.storageState)
    await use(api)
    await api.dispose()
  }
})

export { expect }
