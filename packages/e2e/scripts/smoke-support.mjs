import { chromium } from '@playwright/test'
import { WEB_URL } from '../config.mjs'

/**
 * Shared rig for the two Foldkit smoke scripts (`test:smoke:foldkit`,
 * `test:smoke:foldkit:sync`).
 *
 * Both drive the same local stack through the Vite proxy with the same browser
 * profile, the same registration form and the same "a console error is a
 * failure" rule, so that rig lives here. Each script keeps only its own flow.
 *
 * The console filter is a parameter because the two runs legitimately differ:
 * the auth script only sees the 401 a signed-out boot logs from `/auth/me`,
 * while the sync script also cuts the API with `route.abort('connectionrefused')`
 * and expects those failures too.
 */

export const BASE = WEB_URL

/** The one password every smoke account uses; the flows never change it. */
export const PASSWORD = 'correct horse battery'

/** Persian UI, Tehran wall clock — the same profile the gate flows use. */
const contextOptions = {
  locale: 'fa-IR',
  timezoneId: 'Asia/Tehran',
  viewport: { width: 1280, height: 800 },
}

const expected401 = message => message.includes('401 (Unauthorized)')

export const isExpectedNetworkNoise = message =>
  expected401(message) || message.includes('ERR_CONNECTION_REFUSED')

export const preflight = async () => {
  let response
  try {
    response = await fetch(`${BASE}/health`)
  } catch {
    throw new Error(
      `The Foldkit app is not reachable on ${BASE}. Start the local stack with \`pnpm dev\`.`,
    )
  }

  if (!response.ok) {
    throw new Error(
      `The api Worker is not reachable through ${BASE}/health (HTTP ${response.status}). Start the local stack with \`pnpm dev\`.`,
    )
  }
}

/** The launched page the helpers below drive. */
let page

/**
 * Launch one browser and context, and start collecting what must not happen.
 * `close()` tears the whole browser down, including the extra contexts a flow
 * opens for a second device.
 */
export const launchApp = async (isExpectedConsoleError = expected401) => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext(contextOptions)
  page = await context.newPage()
  const consoleErrors = []
  const pageErrors = []

  page.on('console', message => {
    if (message.type() === 'error' && !isExpectedConsoleError(message.text())) {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', error => {
    pageErrors.push(error.message)
  })

  return {
    browser,
    context,
    page,
    consoleErrors,
    pageErrors,
    close: () => browser.close(),
  }
}

export const log = message => console.log(`PASS ${message}`)

export const waitForHeading = name =>
  page.getByRole('heading', { name, exact: true }).waitFor({ timeout: 15_000 })

export const register = async (displayName, email) => {
  await page.goto(`${BASE}/register`)
  await waitForHeading('ساخت حساب')
  await page.getByLabel('نام نمایشی').fill(displayName)
  await page.getByLabel('ایمیل').fill(email)
  await page.getByLabel('گذرواژه').fill(PASSWORD)
  await page.getByRole('button', { name: 'ساخت حساب' }).click()
}
