import {
  BASE,
  PASSWORD,
  launchApp,
  log,
  preflight,
  register,
  waitForHeading,
} from './smoke-support.mjs'

/**
 * The P2.3 auth smoke check against the Foldkit app on :3001.
 *
 * Run `pnpm dev` first: it starts the api Worker on :8787 and the Foldkit app
 * on :3001. This script registers a fresh account through the Vite proxy,
 * creates a household, reloads into /today, signs out, logs back in, and
 * checks the guard redirects and the no-household onboarding path.
 */

const stamp = Date.now()
const firstEmail = `smoke+${stamp}@example.com`
const secondEmail = `smoke+${stamp}+2@example.com`

const { page, consoleErrors, pageErrors, close } = await launchApp()

const signOut = async () => {
  await page.locator('summary[aria-label="حساب کاربری"]').click()
  await page.getByRole('button', { name: 'خروج' }).click()
  await page.waitForURL(`${BASE}/login`, { timeout: 15_000 })
}

try {
  await preflight()

  await register('مالک', firstEmail)
  await page.waitForURL(`${BASE}/household`, { timeout: 20_000 })
  await waitForHeading('خانه‌ی مشترک')
  log('register lands on /household')

  await page.getByRole('button', { name: 'ساختن خانه' }).click()
  const inviteCode = page.locator('[data-testid="household-invite-code"]')
  await inviteCode.waitFor({ timeout: 15_000 })
  const code = (await inviteCode.textContent())?.trim()
  if (code === undefined || code === '') {
    throw new Error('The invite code was empty')
  }
  log('creating a household shows the invite code')

  await page.getByRole('button', { name: 'ادامه به امروز' }).click()
  await page.waitForURL(`${BASE}/today`, { timeout: 15_000 })
  await waitForHeading('امروز')
  log('continuing from the invite panel lands on /today')

  await page.reload()
  await waitForHeading('امروز')
  if (new URL(page.url()).pathname !== '/today') {
    throw new Error(`Reload left the app at ${page.url()}`)
  }
  await page
    .locator('header')
    .getByText('مالک', { exact: true })
    .first()
    .waitFor({ timeout: 15_000 })
  log('reload restores the session and the header display name')

  await page.goto(`${BASE}/login`)
  await page.waitForURL(`${BASE}/today`, { timeout: 15_000 })
  log('a signed-in account is redirected away from /login')

  await page.goto(`${BASE}/`)
  await page.waitForURL(`${BASE}/today`, { timeout: 15_000 })
  log('/ redirects a household member to /today')

  await signOut()
  log('sign out lands on /login')

  await page.goto(`${BASE}/today`)
  await page.waitForURL(`${BASE}/login`, { timeout: 15_000 })
  log('a signed-out visitor to /today is redirected to /login')

  await page.goto(`${BASE}/`)
  await page.waitForURL(`${BASE}/login`, { timeout: 15_000 })
  log('/ redirects a signed-out visitor to /login')

  await page.getByLabel('ایمیل').fill(firstEmail)
  await page.getByLabel('گذرواژه').fill(PASSWORD)
  await page.getByRole('button', { name: 'ورود' }).click()
  await page.waitForURL(`${BASE}/today`, { timeout: 20_000 })
  await waitForHeading('امروز')
  log('logging back in lands on /today')

  await page.reload()
  await waitForHeading('امروز')
  log('reload after login stays authenticated')

  await signOut()

  await register('مالک دوم', secondEmail)
  await page.waitForURL(`${BASE}/household`, { timeout: 20_000 })
  await waitForHeading('خانه‌ی مشترک')
  log('a second account without a household lands on /household')

  await page.reload()
  await waitForHeading('خانه‌ی مشترک')
  if (new URL(page.url()).pathname !== '/household') {
    throw new Error(`Reload left onboarding at ${page.url()}`)
  }
  log('reload keeps an account without a household on /household')

  await page.goto(`${BASE}/`)
  await page.waitForURL(`${BASE}/household`, { timeout: 15_000 })
  log('/ redirects an account without a household to /household')

  await signOut()
  log('the account menu signs out from onboarding too')

  if (consoleErrors.length > 0) {
    throw new Error(`Console errors:\n${consoleErrors.join('\n')}`)
  }
  if (pageErrors.length > 0) {
    throw new Error(`Page errors:\n${pageErrors.join('\n')}`)
  }

  console.log('SMOKE PASS')
} finally {
  await close()
}
