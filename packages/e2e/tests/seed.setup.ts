import { expect, request, test as setup, type APIRequestContext } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { API_URL, STATE_DIR, uniqueTag } from "./support"

/**
 * Seed the two identities every gate flow shares (#81/#84).
 *
 * Registration and the household handshake go through the real HTTP routes —
 * the same ones the boundary suite drives — rather than the UI: flow 1 is the
 * one that proves the UI path, and repeating it in every flow would make the
 * suite slower and its failures ambiguous. Each identity's session cookie is
 * saved as Playwright `storageState`, which is how the other flows start
 * signed in.
 *
 * The cookie is host-scoped (`localhost`) and browsers ignore ports for
 * cookies, so a session minted on :8787 is sent to the SPA on :3000.
 */

const LOGIN_KEY = "a".repeat(43) // any 43-char base64url key: the API never derives it

const register = async (
  api: APIRequestContext,
  email: string,
  displayName: string
): Promise<{ userId: string }> => {
  const response = await api.post("/auth/register", {
    data: { email, loginKey: LOGIN_KEY, displayName, timeZone: "Asia/Tehran" }
  })
  expect(response.status(), `register ${email} → ${response.status()}`).toBe(201)
  const body = (await response.json()) as { user: { id: string } }
  return { userId: body.user.id }
}

setup("seed two users in one household", async () => {
  const runTag = uniqueTag()
  mkdirSync(STATE_DIR, { recursive: true })

  const alice = await request.newContext({ baseURL: API_URL })
  const bob = await request.newContext({ baseURL: API_URL })

  try {
    const aliceUser = await register(alice, `e2e-alice-${runTag}@tali.test`, "آلیس")
    const created = await alice.post("/household", { data: { name: `خانهٔ آزمون ${runTag}` } })
    expect(created.status(), `create household → ${created.status()}`).toBe(201)
    const household = (await created.json()) as {
      household: { id: string; inviteCode: string }
    }

    const bobUser = await register(bob, `e2e-bob-${runTag}@tali.test`, "باب")
    const joined = await bob.post("/household/join", {
      data: { inviteCode: household.household.inviteCode }
    })
    expect(joined.status(), `join household → ${joined.status()}`).toBe(200)

    const aliceState = join(STATE_DIR, "alice.json")
    const bobState = join(STATE_DIR, "bob.json")
    await alice.storageState({ path: aliceState })
    await bob.storageState({ path: bobState })

    writeFileSync(
      join(STATE_DIR, "seed.json"),
      JSON.stringify(
        {
          runTag,
          householdId: household.household.id,
          inviteCode: household.household.inviteCode,
          alice: { userId: aliceUser.userId, email: `e2e-alice-${runTag}@tali.test`, storageState: aliceState },
          bob: { userId: bobUser.userId, email: `e2e-bob-${runTag}@tali.test`, storageState: bobState }
        },
        null,
        2
      )
    )
  } finally {
    await alice.dispose()
    await bob.dispose()
  }
})
