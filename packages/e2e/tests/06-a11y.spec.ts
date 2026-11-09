import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import type { AxeResults, Result } from 'axe-core'

import { expect, test, WEB_URL } from './support'

/**
 * The single accessibility pass from the verification strategy (#81/#86).
 *
 * One axe run per primary route, in the signed-in shell a real user sees, plus
 * the two guest screens. It is a *gate*, not an audit: the assertion is zero
 * WCAG 2.1 A/AA violations, so a regression fails the nightly run the same way
 * a broken flow does.
 *
 * What axe cannot see stays manual (the two-user acceptance week in
 * `docs/verification.md`): keyboard-only ordering, focus visibility on touch,
 * screen-reader phrasing in Persian, and RTL reading order.
 */

const describeViolation = (violation: Result): string => {
  const nodes = violation.nodes
    .slice(0, 3)
    .map(node => `      ${node.target.join(' ')}`)
    .join('\n')
  const more =
    violation.nodes.length > 3
      ? `\n      …and ${violation.nodes.length - 3} more`
      : ''
  return [
    `  ${violation.id} (${violation.impact ?? 'n/a'}): ${violation.help}`,
    `    ${violation.helpUrl}`,
    nodes + more,
  ].join('\n')
}

const expectNoViolations = (results: AxeResults, route: string): void => {
  const violations = results.violations.filter(
    violation => violation.impact !== 'minor',
  )
  const report = violations.map(describeViolation).join('\n\n')
  expect(
    violations.map(violation => violation.id),
    violations.length === 0
      ? ''
      : `${route}: ${violations.length} accessibility violation(s)\n\n${report}`,
  ).toEqual([])
}

const audit = async (page: Page, route: string): Promise<void> => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expectNoViolations(results, route)
}

/**
 * The signed-in destinations, in navigation order. `main` must be visible, so
 * a screen that failed to render fails here instead of passing an empty audit.
 */
const SIGNED_IN_ROUTES: ReadonlyArray<readonly [path: string, name: string]> = [
  ['/today', 'today'],
  ['/calendar', 'calendar'],
  ['/tasks', 'tasks'],
  ['/habits', 'habits'],
  ['/lists', 'lists'],
  ['/notes', 'notes'],
  ['/reminders', 'reminders'],
  ['/settings', 'settings'],
  ['/household', 'household'],
  ['/capture', 'capture'],
]

for (const [path, name] of SIGNED_IN_ROUTES) {
  test(`a11y: ${name} has no A/AA violations`, async ({ alicePage }) => {
    await alicePage.goto(path)
    await expect(alicePage.locator('main')).toBeVisible()
    // Let the local-first screen settle: an optimistic row that appears after
    // the audit would otherwise be audited on the next run only.
    await alicePage.waitForTimeout(500)
    await audit(alicePage, path)
  })
}

test('a11y: login has no A/AA violations', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: WEB_URL })
  try {
    const page = await context.newPage()
    await page.goto('/login')
    await expect(page.locator('main')).toBeVisible()
    await audit(page, '/login')
  } finally {
    await context.close()
  }
})

test('a11y: register has no A/AA violations', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: WEB_URL })
  try {
    const page = await context.newPage()
    await page.goto('/register')
    await expect(page.locator('main')).toBeVisible()
    await audit(page, '/register')
  } finally {
    await context.close()
  }
})
