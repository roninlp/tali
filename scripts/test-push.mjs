#!/usr/bin/env node
/*
 * Send one Web Push message to a subscription this browser registered.
 *
 * This is the local exit-criterion harness for the Web Push shell (ticket #20).
 * It is intentionally NOT the reminder dispatcher: no D1 scan, no ledger, no
 * retry policy. It only proves an installed PWA's service worker receives an
 * `aes128gcm` payload and shows the Done/Snooze notification.
 *
 * Usage:
 *   pnpm test:push                       # reads .push-subscription.json
 *   pnpm test:push path/to/subscription.json
 *   PUSH_SUBSCRIPTION='{"endpoint":...}' pnpm test:push
 *
 * VAPID values come from the environment or from `apps/api/.dev.vars`; only the
 * private key is required (the public half is derived). Generate a pair with
 * `pnpm exec web-push generate-vapid-keys` — no key is committed to this repo.
 * See docs/web-push-local.md.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import webpush from 'web-push'
import { loadEnvFiles, repoRoot } from './lib/env.mjs'
import { publicKeyOf } from './lib/vapid.mjs'

// The dev vars and the app's local env first, then the shell overrides them.
const env = {
  ...loadEnvFiles([
    resolve(repoRoot, 'apps/api/.dev.vars'),
    resolve(repoRoot, 'apps/web-foldkit/.env.local'),
  ]),
  ...process.env,
}

const privateKey = env.VAPID_PRIVATE_KEY
const publicKey =
  env.VAPID_PUBLIC_KEY ?? (privateKey ? publicKeyOf(privateKey) : undefined)
const subject = env.VAPID_SUBJECT ?? 'mailto:tali@example.com'

const fail = message => {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

if (!privateKey || !publicKey) {
  fail(
    'VAPID_PRIVATE_KEY is missing. Generate a pair with ' +
      '`pnpm exec web-push generate-vapid-keys` and export it (or put it in ' +
      'apps/api/.dev.vars). No key pair ships with this repository. ' +
      'See docs/web-push-local.md §1.',
  )
}

const subscriptionJson = (() => {
  if (
    typeof env.PUSH_SUBSCRIPTION === 'string' &&
    env.PUSH_SUBSCRIPTION.trim() !== ''
  ) {
    return env.PUSH_SUBSCRIPTION
  }
  const path =
    process.argv[2] ??
    env.PUSH_SUBSCRIPTION_FILE ??
    resolve(repoRoot, '.push-subscription.json')
  const resolved = resolve(repoRoot, path)
  if (!existsSync(resolved)) {
    fail(
      `Subscription file not found: ${resolved}. In the app open /settings, enable notifications, ` +
        'then press “رونوشت اشتراک برای آزمون” and save the JSON there.',
    )
  }
  return readFileSync(resolved, 'utf8')
})()

let subscription
try {
  subscription = JSON.parse(subscriptionJson)
} catch {
  fail('The subscription is not valid JSON.')
}

if (
  typeof subscription?.endpoint !== 'string' ||
  typeof subscription?.keys?.p256dh !== 'string' ||
  typeof subscription?.keys?.auth !== 'string'
) {
  fail('The subscription must contain endpoint and keys.p256dh/keys.auth.')
}

const payload = {
  type: 'reminder',
  id: `test-${Date.now()}`,
  title: env.PUSH_TITLE ?? 'یادآوری آزمایشی تالی',
  body:
    env.PUSH_BODY ??
    'اگر این اعلان را می‌بینید، کانال Web Push روی این دستگاه کار می‌کند.',
  tier: 'normal',
  url: '/reminders',
}

webpush.setVapidDetails(subject, publicKey, privateKey)

try {
  const response = await webpush.sendNotification(
    subscription,
    JSON.stringify(payload),
    {
      // The shell only needs to prove delivery while the browser is reachable.
      TTL: 300,
      urgency: 'high',
    },
  )
  const host = new URL(subscription.endpoint).host
  console.log(`\n✔ Push accepted by ${host} (HTTP ${response.statusCode}).`)
  console.log(
    '  Check the notification (Done / Snooze), then see /settings for the last action.\n',
  )
} catch (error) {
  const status = error?.statusCode ?? 'network'
  const body = typeof error?.body === 'string' ? error.body.slice(0, 300) : ''
  console.error(`\n✖ Push failed (${status}). ${body}\n`)
  if (status === 404 || status === 410) {
    console.error(
      '  This subscription is dead: enable notifications again in /settings and retry.\n',
    )
  } else if (status === 401 || status === 403) {
    console.error(
      '  VAPID rejected: check that the private/public keys are a matching pair and the subject is a valid mailto:/https: URI.\n',
    )
  }
  process.exit(1)
}
