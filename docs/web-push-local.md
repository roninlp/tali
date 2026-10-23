# Web Push: dispatch, the missed inbox, and local testing

Tickets: [#20](https://github.com/roninlp/tali/issues/20) (shell),
[#61](https://github.com/roninlp/tali/issues/61) (delivery).
Design: [ADR-0005](./adr/0005-reminder-firing.md) and
[`docs/research/web-push-workers.md`](./research/web-push-workers.md).

## What runs now

- **The clock** — one per-minute cron trigger (`crons: ["* * * * *"]` in
  `infra/alchemy.run.ts`) on the api Worker, handled by `scheduled()` in
  `apps/api/src/index.ts`. It calls the sweep with `controller.scheduledTime`
  (the nominal minute), never `Date.now()`.
- **The sweep** (`apps/api/src/reminder-sweep.ts`) — a catch-up query: first
  materialise the due **occasion advance reminders** for a two-day-back /
  one-day-forward window (`#59`/`#74` left the production trigger to `#61`; the
  sweep is the only writer when no browser is open), then claim every live
  reminder whose `fire_at <= now` in one batch, then push every owed dispatch
  whose `deliver_at` has arrived. The dispatch row is the mutex, so a late,
  repeated or overlapping tick cannot lose or duplicate a fire.
- **The policy** runs once, at claim time, inside `ReminderService.claim`:
  quiet hours 23:00–07:00 in the owner's zone produce a later `deliver_at`, the
  medication tier bypasses them, and a Silence suppresses instead of holding.
  The worker never second-guesses it.
- **Delivery** (`apps/api/src/push-crypto.ts`, `push-gateway.ts`) — ES256 VAPID
  JWT (`Authorization: vapid t=…, k=…`) plus `aes128gcm` encryption against the
  subscription's `p256dh`/`auth`, with `TTL` = the remaining 15-minute horizon,
  `Urgency: high` for medication, and a `Topic` hashed from the dispatch id.
- **The answer** — the notification's **Done / Snooze** buttons post the
  dispatch id back to `POST /reminders/dispatches/:id/respond`. The service
  worker writes the tap to a durable device queue first, then flushes it; the
  page drains the same queue on its next open, so an offline tap is never lost.
  The notification's Snooze defaults to **10 minutes** (the in-app inbox offers
  the full 5/10/15/30/60 preset list).
- **The missed inbox** — `/reminders` reads `GET /reminders/inbox`: unanswered
  dispatches whose instant has passed, with the same Done/Snooze/Dismiss
  actions. After 24 hours they move to the history view; ledger rows are never
  deleted. A closed browser, a dead subscription and a failed push all land
  here, because the ledger — not the push — is the source of truth.

## 1. VAPID keys

The browser no longer needs a build-time key. `GET /push/vapid` returns the
server's public key, and the web app passes it to `pushManager.subscribe()`.
That matters: a subscription created with a different key makes the push
service reject every message with `403`, silently.

**No key pair is committed to this repository, not even a development one.**
A committed private key is a leaked key; generate your own and keep it out of
git:

```sh
pnpm exec web-push generate-vapid-keys
# prints a public and a private key
```

Only the private key is needed — `alchemy.run.ts` derives the public half with
Node's ECDH at startup/deploy time. `alchemy dev` reads the **shell
environment** (not `.dev.vars`), so export it before `pnpm dev`:

```sh
export VAPID_PRIVATE_KEY=<private key>
export VAPID_SUBJECT=mailto:dev@tali.local   # optional locally
pnpm dev
```

Without a key, local dispatch is disabled: the sweep still writes the ledger
row, so every reminder lands in the inbox, and `GET /push/vapid` returns
`null` (the panel says so).

**Deploying** needs a real identity:

- `VAPID_PRIVATE_KEY` — a Workers **secret**.
- `VAPID_SUBJECT` — a real `mailto:` or `https:` URI. Apple's push service
  rejects localhost subjects. Both are required: a deploy without them fails
  instead of silently shipping an inbox-only app.
- `VAPID_PUBLIC_KEY` — optional; derived from the private key when omitted. Set
  it only if your secret store cannot derive it, and it **must** match the
  private key (a mismatch makes every push fail with `403`).

Rotating the pair invalidates every existing subscription.

`scripts/test-push.mjs` and `pnpm test:push` also read `apps/api/.dev.vars`
(git-ignored) — put the same pair there if you want the hand-send harness.

`VITE_VAPID_PUBLIC_KEY` is no longer read: the browser always asks
`GET /push/vapid`, so a stale build-time key cannot shadow the signer.

## 2. Run the app

```sh
pnpm dev        # alchemy dev: local D1 (migrations applied) + api on :8787 + web on :3000
```

Open <http://localhost:3000> (localhost is a secure context, so Web Push works
without HTTPS), sign in, create or join the household, then go to **تنظیمات**
(`/settings`) or **یادآورها** (`/reminders`).

## 3. Install the PWA and subscribe

- **Desktop Chrome/Edge:** install icon in the address bar (or ⋮ → “Install
  Tali”). The health panel switches “نصب‌شده” to «بله».
- **Android Chrome:** ⋮ → “Add to Home screen” / “Install app”.
- **iOS Safari 16.4+:** Share → “Add to Home Screen”. Push permission is only
  offered from the installed app, and action buttons are not reliably shown —
  the in-app inbox is the answer path there.

Then press **فعال‌سازی اعلان‌ها** and allow notifications. The panel should show
«مجوز اعلان: فعال», «اشتراک این دستگاه: ثبت شده» and «کلید عمومی VAPID: تنظیم
شده».

## 4. Drive the sweep locally

`alchemy dev` runs no cron triggers, so there are three ways to advance the
clock:

```sh
# 1. The dev trigger — one tick at an explicit instant (registered only in dev)
curl -X POST 'http://localhost:8787/dev/reminders/sweep?at=2026-10-21T09:00:00.000Z'

# 2. Omit `at` to sweep "now"
curl -X POST 'http://localhost:8787/dev/reminders/sweep'

# 3. The real scheduled() path, through the local cron route
curl -X POST 'http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*'
```

The response is the tick's counters: `claimed`, `pushed`, `accepted`, `failed`,
`expired`, `subscriptionsDeleted`. `/dev/reminders/sweep` is **not registered**
when the Worker is deployed (`DEV_ROUTES=0`), so it cannot be called in
production.

To watch a reminder arrive end to end:

1. Insert (or later, create from the UI) a reminder whose `fire_at` is a few
   seconds away, with `tier = 'critical'` or a time outside quiet hours.
2. `POST /dev/reminders/sweep?at=<that fire instant>`.
3. The notification appears with **انجام شد** / **بعداً**; tap Done and reload
   `/reminders` — nothing is in the inbox, and `GET /reminders/inbox?history=1`
   shows the answered row.
4. Repeat with the browser **closed**: the tick still claims and records the
   dispatch, and `/reminders` shows it in the inbox on the next open.

To inspect the ledger directly:

```sh
curl -b <cookie> http://localhost:8787/reminders/inbox
curl -b <cookie> 'http://localhost:8787/reminders/inbox?history=1'
```

## 5. Send one push by hand (the receiver-only harness)

`scripts/test-push.mjs` still works and is independent of the sweep. In dev
builds the panel shows **رونوشت اشتراک برای آزمون**; save the JSON to a
git-ignored `.push-subscription.json` in the repo root, then:

```sh
pnpm test:push
pnpm test:push ~/tali-subscription.json
PUSH_SUBSCRIPTION='{"endpoint":...}' pnpm test:push
PUSH_TITLE="دارو" PUSH_BODY="ایبوپروفن ۴۰۰" pnpm test:push
```

The script reads `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT` from
the environment, then `apps/api/.dev.vars`. Use the pair you generated in §1
(the private key must be the one the Worker is signing with):

```sh
VAPID_PRIVATE_KEY=<your generated private key>
VAPID_PUBLIC_KEY=<its public half, if the script cannot derive it>
VAPID_SUBJECT=mailto:dev@tali.local
```

Because this payload is not a real dispatch (no ledger row), its Done/Snooze
tap is answered `404` and dropped by the drain — that is expected.

## 6. What still needs a real device or secret

Proven locally, with real WebCrypto and a fake push service: the VAPID JWT
shape and signature, the `aes128gcm` bytes against the RFC 8291 Appendix A
vector, claim → push → outcome, retry/expiry, subscription deletion on
`404`/`410`, the inbox query, and the Done/Snooze response path (including
snooze children and on-time maths).

Needs a real device/browser:

- actual delivery through a vendor push service (FCM/Mozilla/Apple) and the
  notification rendering;
- action buttons on iOS (still unreliable);
- a genuinely expired subscription (`410`) from a live endpoint;
- the push service's own TTL queueing while the device is offline.

Needs a real secret: a production VAPID key pair — a locally generated pair is
not an identity.

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Panel says «پشتیبانی نمی‌شود» | Browser lacks Push API, or the page is not a secure context. Use localhost/HTTPS and a modern Chrome, Edge, Firefox, or installed iOS Safari. |
| Permission stays «مسدود شده» | Previously denied. Re-allow notifications for the site in browser settings, then press “تازه‌سازی وضعیت” (the page cannot re-prompt after a denial). |
| Panel says the VAPID key is missing | `GET /push/vapid` returned `null`: the API has no `VAPID_*` values. In dev, export `VAPID_PRIVATE_KEY` before `pnpm dev` (§1). |
| A reminder is claimed but no notification arrives | `subscriptionsDeleted`/`expired` in the tick, or the device has no subscription row. Check `/reminders` for the inbox row; check `push_subscriptions` for the device. |
| `pnpm test:push` → 401/403 | VAPID mismatch: the browser subscribed with a different public key than the script signs with. Unsubscribe/re-subscribe after fixing the key. |
| Notification never arrives | Check the installed PWA is the same origin that registered; on desktop make sure the browser process is running. DevTools → Application → Service Workers → “Update on reload”. |
| Old service worker during development | DevTools → Application → Service Workers → “Update on reload”, or unregister and reload once. |
| Queue keeps an old tap | The dispatch was `404` (dropped) or the session was `401` (kept). Sign in and open `/reminders`; the drain retries. |

## 8. Cost and limits (Free plan)

1,440 ticks/day ≈ 1.4 % of the 100 k daily request quota. `alchemy deploy`
attaches the cron trigger; cron changes propagate in up to 15 minutes. A tick
performs three scheduling reads plus one occasion-discovery read and one
household-scoped dedupe read with due drafts, one claim batch, one take-attempts
statement, ≤10 VAPID signatures + `aes128gcm` payloads (the fetch cap; overflow
rolls to the next minute) and one outcome batch. The busiest realistic tick
exercised in the tests (10 claims, 10 pushes, one occasion create) issues **33
D1 statements**, inside the Free plan's 50-per-invocation ceiling. Nothing is
scheduled ahead, so a deploy, an outage or a skipped tick loses no state — the
next tick sees the same rows.

**Not measured yet:** the Free plan's 10 ms CPU ceiling per invocation. The
work per tick is fixed and small (one ES256 signature + one HKDF/AES-GCM round
per device), but a local workerd run is not a Free-plan CPU meter. If a busy
tick is found to exceed it, the mechanical knob is `SWEEP_MAX_FETCHES` (and
`SWEEP_MAX_DISPATCHES`, `SWEEP_MAX_OCCASION_CREATES`) — lower it rather than
adding a queue.
