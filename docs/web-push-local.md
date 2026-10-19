# Web Push locally — service worker + test notification

Ticket: [#20](https://github.com/roninlp/tali/issues/20) (Slice 1 / Foundation).
Research: [`docs/research/web-push-workers.md`](./research/web-push-workers.md).
Reminder action semantics: [`docs/reminder-policy-draft.md`](./reminder-policy-draft.md).

This shell ships **registration + receipt**, not dispatch:

- `apps/web/public/sw.js` registers, shows a notification on `push`, opens the
  app on a body tap, and records **Done / Snooze** taps in a device-local queue.
- `apps/web/src/lib/push/` owns the VAPID-restricted subscription and
  `POST /push/register`.
- `apps/api/src/push-routes.ts` validates and stores the subscription in D1
  (`push_subscriptions`, migration `0004`). It does **not** send anything.
- `/reminders` and `/settings` show the permission health panel.

The reminder cron, payload encryption on the Worker, dispatch ledger, and
missed-reminder inbox are later slices. To exercise the receiver today, use the
local test script below (it sends a real `aes128gcm` push with `web-push`).

---

## 1. Generate a VAPID key pair (once per environment)

From the repo root:

```sh
pnpm exec web-push generate-vapid-keys
```

Output looks like:

```
=======================================

Public Key:
BExamplePublicKey...

Private Key:
ExamplePrivateKey...

=======================================
```

The pair is the app's stable push identity. Rotating it invalidates every
existing subscription; do not commit the private key.

## 2. Configure the two local processes

The **public** key goes to the web app (it is the
`applicationServerKey`), the **private** key stays with the API / test script.

`apps/web/.env.local` (git-ignored):

```sh
VITE_VAPID_PUBLIC_KEY=<public key>
# Optional; this is the default for `wrangler dev`.
VITE_API_URL=http://localhost:8787
```

`apps/api/.dev.vars` (git-ignored; `wrangler dev` reads it):

```sh
VAPID_PUBLIC_KEY=<public key>
VAPID_PRIVATE_KEY=<private key>
VAPID_SUBJECT=mailto:you@example.com
WEB_ORIGIN=http://localhost:3000
```

`VAPID_SUBJECT` must be a real `mailto:` or `https:` URI; Apple's push service
rejects localhost subjects. The API route does not sign anything yet, but the
test script does, and the same values will become the Worker's secrets.

## 3. Apply the migration and run the app

```sh
cd apps/api
pnpm wrangler d1 migrations apply DB --local
pnpm dev                      # wrangler dev on :8787
```

In a second terminal:

```sh
cd apps/web
pnpm dev                      # Vite on :3000
```

Open <http://localhost:3000> (localhost is a secure context, so Web Push works
without HTTPS), then register/sign in, create or join the household, and go to
**تنظیمات** (`/settings`) or **یادآورها** (`/reminders`).

## 4. Install the PWA and subscribe

- **Desktop Chrome/Edge:** use the install icon in the address bar (or
  ⋮ → “Install Tali”). The health panel should switch “نصب‌شده” to «بله».
- **Android Chrome:** ⋮ → “Add to Home screen” / “Install app”.
- **iOS Safari 16.4+:** Share → “Add to Home Screen”. Web Push permission is
  **only** offered from the installed app. Action buttons may not render on
  iOS, so the in-app inbox remains the reliable path (later slice).

Then in `/settings`:

1. Press **فعال‌سازی اعلان‌ها** and allow notifications when the browser asks.
2. The panel should show «مجوز اعلان: فعال» and «اشتراک این دستگاه: ثبت شده».
3. The row “آخرین پاسخ اعلان” is empty until you act on a notification.

If the panel says the VAPID key is missing, `apps/web/.env.local` was not picked
up — restart `pnpm dev` after creating it.

## 5. Send the test push

In dev builds the panel shows **رونوشت اشتراک برای آزمون**. Press it and save the
JSON to a git-ignored file in the repo root:

```sh
# .push-subscription.json
{ "endpoint": "https://...", "expirationTime": null, "keys": { "p256dh": "...", "auth": "..." } }
```

Then:

```sh
pnpm test:push
```

You can also point at another file or pass the JSON inline:

```sh
pnpm test:push ~/tali-subscription.json
PUSH_SUBSCRIPTION='{"endpoint":...}' pnpm test:push
PUSH_TITLE="دارو" PUSH_BODY="ایبوپروفن ۴۰۰" pnpm test:push
```

The script reads `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT` from
the environment first, then from `apps/api/.dev.vars` and
`apps/web/.env.local` (as `VITE_VAPID_PUBLIC_KEY`).

**Expected:** a notification titled «یادآوری آزمایشی تالی» with **انجام شد** and
**بعداً** buttons. With the app closed but the browser running, the service
worker still shows it. Tap Done/Snooze and reopen `/settings`: the panel reads
the queue back and shows “آخرین پاسخ اعلان”.

The service worker writes taps to IndexedDB `tali.push.v1` → `actions`
(non-destructive). The reminder slice will drain this queue into the sync
outbox / `ReminderDispatch` ledger; today it is the proof that the action
handler is wired.

## 6. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Panel says «پشتیبانی نمی‌شود» | Browser lacks Push API, or the page is not a secure context. Use localhost/HTTPS and a modern Chrome, Edge, Firefox, or installed iOS Safari. |
| Permission stays «مسدود شده» | Previously denied. Re-allow notifications for the site in browser settings, then press “تازه‌سازی وضعیت” (the page cannot re-prompt after a denial). |
| `pnpm test:push` → 404/410 | The push endpoint is dead (browser data cleared, subscription rotated). Enable notifications again and copy the new subscription. |
| `pnpm test:push` → 401/403 | VAPID mismatch: regenerate/copy the pair, and use a valid `VAPID_SUBJECT`. |
| Notification never arrives | Check the installed PWA is running the same origin that registered; on desktop make sure the browser process is running (the push service retries up to `TTL`). Also try DevTools → Application → Service Workers → “Update on reload”. |
| Old service worker during development | DevTools → Application → Service Workers → “Update on reload”, or unregister and reload once. |

## 7. Production notes (for the dispatch slice)

- `VAPID_PRIVATE_KEY` becomes a Workers **secret**; the public key and subject
  are ordinary config. Declare the secret as required in Wrangler/Alchemy.
- The API stores `endpoint` as a unique capability URL. Never expose it back to
  a client — anyone holding it can send notifications.
- This shell intentionally has no scheduler, no dispatch ledger, no retry, and
  no quiet-hours handling. Those belong to the reminder slice and must treat
  the ledger (not the push) as the source of truth.
