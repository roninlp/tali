import { expect, test } from "@playwright/test"
import { uniqueTag } from "./support"

/**
 * Gate flow 1 (#81/#84): register → create household → invite → second account
 * joins by code.
 *
 * This is the only flow that drives the real registration/join forms. It uses
 * its own two accounts rather than the seeded pair so a failure here names the
 * signup path, not the seed fixture.
 */
test("flow 1: two accounts meet in one household", async ({ browser, playwright }) => {
  const tag = uniqueTag()
  const aliceEmail = `gate1-a-${tag}@tali.test`
  const bobEmail = `gate1-b-${tag}@tali.test`
  const password = "correct horse battery staple"

  const alice = await browser.newContext()
  const bob = await browser.newContext()

  try {
    const alicePage = await alice.newPage()

    // ── A registers ──────────────────────────────────────────────────────
    await alicePage.goto("/register")
    await expect(alicePage.getByRole("heading", { name: "ساخت حساب" })).toBeVisible()
    await alicePage.getByLabel("نام نمایشی").fill("آلیس")
    await alicePage.getByLabel("ایمیل").fill(aliceEmail)
    // The password label carries its hint ("حداقل ۱۲ نویسه"), so match the
    // visible prefix rather than an exact accessible name.
    await alicePage.locator("#register-password").fill(password)
    await alicePage.getByRole("button", { name: "ساخت حساب" }).click()

    await expect(alicePage).toHaveURL(/\/household$/)

    // ── A creates the household and gets the invite code ─────────────────
    await alicePage.getByLabel("نام خانه").fill(`خانهٔ گیت ${tag}`)
    await alicePage.getByRole("button", { name: "ساختن خانه" }).click()
    await expect(alicePage.getByRole("heading", { name: "خانه ساخته شد" })).toBeVisible()

    const inviteCode = (await alicePage.getByTestId("household-invite-code").textContent())?.trim() ?? ""
    expect(inviteCode).toMatch(/^[0-9a-f]{16}$/)

    await alicePage.getByRole("button", { name: "ادامه به امروز" }).click()
    await expect(alicePage).toHaveURL(/\/today$/)
    await expect(alicePage.getByRole("heading", { name: "امروز", level: 1 })).toBeVisible()

    // ── B registers and joins with the code ──────────────────────────────
    const bobPage = await bob.newPage()
    await bobPage.goto("/register")
    await bobPage.getByLabel("نام نمایشی").fill("باب")
    await bobPage.getByLabel("ایمیل").fill(bobEmail)
    await bobPage.locator("#register-password").fill(password)
    await bobPage.getByRole("button", { name: "ساخت حساب" }).click()

    await expect(bobPage).toHaveURL(/\/household$/)
    await bobPage.getByLabel("کد دعوت").fill(inviteCode)
    await bobPage.getByRole("button", { name: "پیوستن" }).click()

    await expect(bobPage).toHaveURL(/\/today$/)
    await expect(bobPage.getByRole("heading", { name: "امروز", level: 1 })).toBeVisible()

    // ── Both sessions report the same household ───────────────────────────
    const aliceSession = await playwright.request.newContext({
      baseURL: "http://localhost:8787",
      storageState: await alice.storageState()
    })
    const bobSession = await playwright.request.newContext({
      baseURL: "http://localhost:8787",
      storageState: await bob.storageState()
    })
    try {
      const aliceMe = (await (await aliceSession.get("/auth/me")).json()) as { householdId: string | null }
      const bobMe = (await (await bobSession.get("/auth/me")).json()) as { householdId: string | null }
      expect(aliceMe.householdId).not.toBeNull()
      expect(bobMe.householdId).toBe(aliceMe.householdId)
    } finally {
      await aliceSession.dispose()
      await bobSession.dispose()
    }
  } finally {
    await alice.close()
    await bob.close()
  }
})
