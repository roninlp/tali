import { expect, chromium } from '@playwright/test'

/**
 * The P2.4 sync smoke check against the Foldkit app on :3001.
 *
 * Run `pnpm dev` first. The script registers an account through the Vite
 * proxy, creates a household, writes one task online, switches the browser to
 * the app's offline state, writes a second task, reloads twice, reconnects,
 * and verifies:
 *
 * - both rows survive the offline reload from IndexedDB;
 * - the status pill reports "آفلاین" while the API is cut and "همگام" after
 *   reconnecting;
 * - both rows reached the server's pull feed;
 * - a second signed-in device pulls both rows.
 */

const BASE = 'http://localhost:3001'
const password = 'correct horse battery'
const stamp = Date.now()
const email = `sync+${stamp}@example.com`
const onlineTitle = `نان ${stamp}`
const offlineTitle = `شیر ${stamp}`

const preflight = async () => {
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

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  locale: 'fa-IR',
  timezoneId: 'Asia/Tehran',
  viewport: { width: 1280, height: 800 },
})
const page = await context.newPage()
const consoleErrors = []
const pageErrors = []

const isExpectedNetworkNoise = message =>
  message.includes('401 (Unauthorized)') ||
  message.includes('ERR_CONNECTION_REFUSED')

page.on('console', message => {
  if (message.type() === 'error' && !isExpectedNetworkNoise(message.text())) {
    consoleErrors.push(message.text())
  }
})
page.on('pageerror', error => {
  pageErrors.push(error.message)
})

const log = message => console.log(`PASS ${message}`)
const status = () => page.locator("header span[role='status']")
const taskList = () => page.locator('.today-list')
const quickAdd = () => page.getByLabel('کار تازه برای امروز')
const waitForHeading = name =>
  page.getByRole('heading', { name, exact: true }).waitFor({ timeout: 15_000 })
const waitForStatus = async text => {
  await status().filter({ hasText: text }).waitFor({ timeout: 30_000 })
}

const register = async (displayName, accountEmail) => {
  await page.goto(`${BASE}/register`)
  await waitForHeading('ساخت حساب')
  await page.getByLabel('نام نمایشی').fill(displayName)
  await page.getByLabel('ایمیل').fill(accountEmail)
  await page.getByLabel('گذرواژه').fill(password)
  await page.getByRole('button', { name: 'ساخت حساب' }).click()
}

const addTask = async title => {
  await quickAdd().waitFor({ timeout: 15_000 })
  await quickAdd().fill(title)
  // The input update crosses the Foldkit runtime queue before the submit
  // handler sees the draft, so wait for the button to enable.
  await expect(page.getByRole('button', { name: 'افزودن کار' })).toBeEnabled()
  await quickAdd().press('Enter')
  await taskList().filter({ hasText: title }).waitFor({ timeout: 15_000 })
}

const pullAll = async request => {
  const rows = []
  let cursor = 0

  for (;;) {
    const response = await request.get(
      `${BASE}/sync/pull?cursor=${cursor}&limit=500`,
    )
    if (!response.ok()) {
      throw new Error(`pull failed: ${response.status()}`)
    }
    const body = await response.json()
    rows.push(...body.items)
    if (!body.hasMore) return rows
    cursor = body.nextCursor
  }
}

try {
  await preflight()

  await register('مالک', email)
  await page.waitForURL(`${BASE}/household`, { timeout: 20_000 })
  await waitForHeading('خانه‌ی مشترک')
  await page.getByRole('button', { name: 'ساختن خانه' }).click()
  await page.locator('[data-testid="household-invite-code"]').waitFor({
    timeout: 15_000,
  })
  await page.getByRole('button', { name: 'ادامه به امروز' }).click()
  await page.waitForURL(`${BASE}/today`, { timeout: 15_000 })
  await waitForHeading('امروز')
  await waitForStatus('همگام')
  log('sign-in lands on /today with a synced status')

  await addTask(onlineTitle)
  await waitForStatus('همگام')
  log('an online quick-add is acknowledged and the queue drains')

  // The SW caches no app shell, so a real offline reload cannot load the
  // document. Flip navigator.onLine (the app's own signal) and cut the API
  // paths instead; Vite still serves the document.
  await context.addInitScript(() => {
    let online = false
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => online,
    })
    window.__taliSetOnline = next => {
      online = next
      window.dispatchEvent(new Event(next ? 'online' : 'offline'))
    }
  })
  await context.route(/\/auth\//, route => route.abort('connectionrefused'))
  await context.route(/\/sync\/(pull|push|bootstrap)/, route =>
    route.abort('connectionrefused'),
  )
  await context.route(/\/rpc$/, route => route.abort('connectionrefused'))
  await page.reload()
  await waitForHeading('امروز')
  await waitForStatus('آفلاین')
  await taskList().filter({ hasText: onlineTitle }).waitFor({ timeout: 15_000 })
  log('the acknowledged task survives an offline reload from IndexedDB')

  await addTask(offlineTitle)
  await waitForStatus('آفلاین')
  log('an offline quick-add is written locally while the API is unreachable')

  await page.reload()
  await waitForHeading('امروز')
  await taskList().filter({ hasText: onlineTitle }).waitFor({ timeout: 15_000 })
  await taskList()
    .filter({ hasText: offlineTitle })
    .waitFor({ timeout: 15_000 })
  await waitForStatus('آفلاین')
  log('both tasks survive a second offline reload')

  await context.unroute(/\/auth\//)
  await context.unroute(/\/sync\/(pull|push|bootstrap)/)
  await context.unroute(/\/rpc$/)
  await page.evaluate(() => window.__taliSetOnline(true))
  await waitForStatus('همگام')
  log('reconnecting drains the outbox and returns to the synced status')

  const rows = await pullAll(context.request)
  const titles = rows
    .filter(row => row.entityType === 'task')
    .map(row => row.data.title)
  if (!titles.includes(onlineTitle) || !titles.includes(offlineTitle)) {
    throw new Error(
      `the server feed is missing a task: ${JSON.stringify(titles)}`,
    )
  }
  log('both tasks reached the household sync feed')

  const second = await browser.newContext({
    locale: 'fa-IR',
    timezoneId: 'Asia/Tehran',
    viewport: { width: 1280, height: 800 },
  })
  const secondPage = await second.newPage()
  try {
    await secondPage.goto(`${BASE}/login`)
    await secondPage.getByLabel('ایمیل').fill(email)
    await secondPage.getByLabel('گذرواژه').fill(password)
    await secondPage.getByRole('button', { name: 'ورود' }).click()
    await secondPage.waitForURL(`${BASE}/today`, { timeout: 20_000 })
    await secondPage
      .locator('.today-list')
      .filter({ hasText: onlineTitle })
      .waitFor({ timeout: 20_000 })
    await secondPage
      .locator('.today-list')
      .filter({ hasText: offlineTitle })
      .waitFor({ timeout: 20_000 })
    log('a second device pulls both tasks and converges')
  } finally {
    await second.close()
  }

  await page.reload()
  await waitForHeading('امروز')
  // The init script starts every document offline; a reload must reconnect
  // explicitly, exactly like the real browser's online event.
  await page.evaluate(() => window.__taliSetOnline(true))
  await taskList().filter({ hasText: onlineTitle }).waitFor({ timeout: 15_000 })
  await taskList()
    .filter({ hasText: offlineTitle })
    .waitFor({ timeout: 15_000 })
  await waitForStatus('همگام')
  log('a final online reload still renders both rows and stays synced')

  if (consoleErrors.length > 0) {
    throw new Error(`Console errors:\n${consoleErrors.join('\n')}`)
  }
  if (pageErrors.length > 0) {
    throw new Error(`Page errors:\n${pageErrors.join('\n')}`)
  }

  console.log('SYNC SMOKE PASS')
} finally {
  await browser.close()
}
