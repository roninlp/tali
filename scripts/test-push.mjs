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
 * VAPID values come from the environment or from `apps/api/.dev.vars` (the
 * public key may also come from `apps/web/.env.local` as VITE_VAPID_PUBLIC_KEY).
 * See docs/web-push-local.md.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import webpush from "web-push"

const root = resolve(import.meta.dirname, "..")

const parseEnvFile = (path) => {
  if (!existsSync(path)) return {}
  const values = {}
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

const fileEnv = {
  ...parseEnvFile(resolve(root, "apps/api/.dev.vars")),
  ...parseEnvFile(resolve(root, "apps/web/.env.local"))
}
const env = { ...fileEnv, ...process.env }

const privateKey = env.VAPID_PRIVATE_KEY
const publicKey = env.VAPID_PUBLIC_KEY ?? env.VITE_VAPID_PUBLIC_KEY
const subject = env.VAPID_SUBJECT ?? "mailto:tali@example.com"

const fail = (message) => {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

if (!privateKey || !publicKey) {
  fail(
    "VAPID keys are missing. Generate a pair and put them in apps/api/.dev.vars " +
      "(VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY) and apps/web/.env.local (VITE_VAPID_PUBLIC_KEY). " +
      "See docs/web-push-local.md."
  )
}

const subscriptionJson = (() => {
  if (typeof env.PUSH_SUBSCRIPTION === "string" && env.PUSH_SUBSCRIPTION.trim() !== "") {
    return env.PUSH_SUBSCRIPTION
  }
  const path = process.argv[2] ?? env.PUSH_SUBSCRIPTION_FILE ?? resolve(root, ".push-subscription.json")
  const resolved = resolve(root, path)
  if (!existsSync(resolved)) {
    fail(
      `Subscription file not found: ${resolved}. In the app open /settings, enable notifications, ` +
        "then press “رونوشت اشتراک برای آزمون” and save the JSON there."
    )
  }
  return readFileSync(resolved, "utf8")
})()

let subscription
try {
  subscription = JSON.parse(subscriptionJson)
} catch {
  fail("The subscription is not valid JSON.")
}

if (
  typeof subscription?.endpoint !== "string" ||
  typeof subscription?.keys?.p256dh !== "string" ||
  typeof subscription?.keys?.auth !== "string"
) {
  fail("The subscription must contain endpoint and keys.p256dh/keys.auth.")
}

const payload = {
  type: "reminder",
  id: `test-${Date.now()}`,
  title: env.PUSH_TITLE ?? "یادآوری آزمایشی تالی",
  body: env.PUSH_BODY ?? "اگر این اعلان را می‌بینید، کانال Web Push روی این دستگاه کار می‌کند.",
  tier: "normal",
  url: "/reminders"
}

webpush.setVapidDetails(subject, publicKey, privateKey)

try {
  const response = await webpush.sendNotification(subscription, JSON.stringify(payload), {
    // The shell only needs to prove delivery while the browser is reachable.
    TTL: 300,
    urgency: "high"
  })
  const host = new URL(subscription.endpoint).host
  console.log(`\n✔ Push accepted by ${host} (HTTP ${response.statusCode}).`)
  console.log("  Check the notification (Done / Snooze), then see /settings for the last action.\n")
} catch (error) {
  const status = error?.statusCode ?? "network"
  const body = typeof error?.body === "string" ? error.body.slice(0, 300) : ""
  console.error(`\n✖ Push failed (${status}). ${body}\n`)
  if (status === 404 || status === 410) {
    console.error("  This subscription is dead: enable notifications again in /settings and retry.\n")
  } else if (status === 401 || status === 403) {
    console.error(
      "  VAPID rejected: check that the private/public keys are a matching pair and the subject is a valid mailto:/https: URI.\n"
    )
  }
  process.exit(1)
}
