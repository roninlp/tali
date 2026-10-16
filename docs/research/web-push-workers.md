# Web Push (VAPID) dispatch from Cloudflare Workers

Research ticket: `roninlp/tali#4` — part of the Must MVP map (`#1`).

**Bottom line:** A Cloudflare Worker can dispatch Web Push end-to-end with no push-service SDK. It needs (a) one static VAPID signing key pair (kept in Workers Secrets), (b) a per-browser `PushSubscription` (`endpoint` + `keys.p256dh` + `keys.auth`) registered by the Solid app's service worker and stored in D1, and (c) a `fetch()` POST to each subscription's `endpoint` with an `aes128gcm`-encrypted body and a `vapid t=…, k=…` Authorization header. Web Push is **best-effort**, so the server-side *dispatch ledger* + *missed-reminder inbox* is the source of truth for "did the reminder actually reach the user", not the push itself.

---

## 1. Actors and trust model

Three parties (RFC 8030 §2):

- **User agent** (browser + service worker) — subscribes, receives.
- **Push service** (the browser vendor's server: `fcm.googleapis.com`, `push.services.mozilla.com`, `web.push.apple.com`, …) — relays.
- **Application server** (our Cloudflare Worker) — sends.

Two key facts that drive the whole design:

1. **The push service cannot read the payload.** TLS protects the *transport* to the push service, but not the payload *from* the push service. Message content must be end-to-end encrypted between our Worker and the user agent, so the payload is encrypted with a per-subscription key pair that only the browser holds (RFC 8030 §8.1).
2. **Delivery is not guaranteed.** "This does not indicate that the message was delivered to the user agent" — a `201 Created` only means the push service *accepted* the message (RFC 8030 §5).

---

## 2. VAPID key generation and storage

### Two unrelated key pairs — do not conflate them

| Key | Purpose | Who generates | Curve / form |
| --- | --- | --- | --- |
| **VAPID signing key** (ours, static) | Identifies/authorizes our application server to the push service | We generate once | ECDSA P-256; public 65 bytes uncompressed (X9.62, base64url), private 32 bytes base64url |
| **Subscription encryption keys** (`p256dh` + `auth`) | Encrypts each message payload per receiver | The browser, per subscription | ECDH P-256 public + 16-byte auth secret |

RFC 8292 §3.2 explicitly requires these to be *different* keys: "An application server MUST select a different private key for the key exchange [RFC8291] and signing the authentication token."

### Generation

`web-push` generates the VAPID pair as an ECDH P-256 key (`crypto.createECDH('prime256v1')`), zero-padding the public key to 65 bytes and the private key to 32 bytes, and base64url-encoding both (`src/vapid-helper.js`, `generateVAPIDKeys`). Output is two URL-safe base64 strings, e.g.:

```
publicKey:  BGtkbcjrO12YMoDuq2sCQeHlu47uPx3SHTgFKZFYiBW8Qr0D9vgyZSZPdw6_4ZFEI9Snk1VEAj2qTYI1I1YxBXE
privateKey: I0_d0vnesxbBSUmlDdOKibGo6vEXRO-Vu88QlSlm5j0
```

The exact curve/encoding is mandated by RFC 8292 §2 (ECDSA over P-256, "ES256"), and the `k` parameter carries the public key in uncompressed X9.62 form (RFC 8292 §3.2). Generate **once**; the key becomes your stable identity and rotating it invalidates every existing subscription (RFC 8292 §4.2).

### The VAPID JWT

For each delivery request we mint a short-lived JWT signed with the private key (RFC 8292 §2):

```
header = { "typ": "JWT", "alg": "ES256" }
claims = {
  "aud": <origin of the push resource URL, e.g. "https://fcm.googleapis.com">,
  "exp": <now + 12h; MUST be ≤ 24h>,
  "sub": <"mailto:..." or "https:..." contact URI>
}
Authorization: vapid t=<JWT>, k=<base64url public key>
```

- `aud` must be the *origin* (scheme + host) of the push resource URL — this binds the token to one push service (RFC 8292 §2).
- `exp` must not exceed 24 hours from the request (RFC 8292 §2). `web-push` defaults to 12h (`DEFAULT_EXPIRATION_SECONDS = 12 * 60 * 60`).
- `sub` SHOULD be a `mailto:` or `https:` URI. **Use a real, externally valid contact URI** — Apple's push service rejects `https://localhost` subjects with `BadJwtToken` (web-push `vapid-helper.js` warning).

### Storage as Cloudflare Workers secrets

- **Private key → Workers Secret.** `wrangler secret put VAPID_PRIVATE_KEY`, read via `env.VAPID_PRIVATE_KEY`. Secrets are encrypted and not visible in Wrangler or the dashboard after being set (Cloudflare Workers *Secrets* doc). Never put it in a `var` / `wrangler.toml`.
- **Public key + subject → plaintext env/config.** They're public by design; keep them in normal config (typed env in `packages/config`).
- Local dev: `.dev.vars` (or `.env`) in the Wrangler dir, git-ignored (`wrangler secret put` equivalent for `wrangler dev`).
- Declare `secrets.required: ["VAPID_PRIVATE_KEY"]` in `wrangler.toml` so `wrangler deploy` fails if the secret is missing.

---

## 3. Payload encryption (content-encoding choice)

Payload encryption is specified by **RFC 8291** (Message Encryption for Web Push). Two encodings exist:

- **`aes128gcm`** — current standard (RFC 8291). Salt and ephemeral DH public key are embedded in the ciphertext body, so no separate `Encryption`/`Crypto-Key` headers. Supported by Chrome 50+, Firefox 46+, Edge 17+, Safari 16+. **Default in web-push.**
- **`aesgcm`** — legacy (RFC 8188). Requires separate `Encryption: salt=…` and `Crypto-Key: dh=…` headers. Only needed for very old clients.

**Recommendation for Tali: use `aes128gcm` only.** The target is two users on a modern installed PWA; there's no legacy client to carry. The browser sends its `p256dh`/`auth` keys with the subscription, and each message is encrypted with a fresh ephemeral key pair and salt against those keys.

In `web-push`, `generateRequestDetails()` does this automatically: with a payload it sets `Content-Encoding: aes128gcm`, `Content-Type: application/octet-stream`, `Content-Length`, and puts the encrypted bytes in the body (web-push `src/web-push-lib.js`). On the receiving side the service worker just reads `event.data.text()`/`.json()` — the browser decrypts using its stored subscription keys.

---

## 4. Concrete dispatch flow

### Step 0 — once per device (client side)

1. Request notification permission (`Notification.requestPermission()`) — user gesture required.
2. Register the service worker (`navigator.serviceWorker.register('/sw.js')`).
3. On `navigator.serviceWorker.ready`, call `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: <VAPID public key> })`.
4. `POST` the resulting `PushSubscription.toJSON()` (`{ endpoint, expirationTime, keys: { p256dh, auth } }`) to our `POST /push/register`; store it in D1 keyed by user + device.

`applicationServerKey` **is** the VAPID public key, and passing it creates a *restricted* subscription: the push service will reject any message that isn't accompanied by a valid VAPID JWT signed by the matching private key (RFC 8292 §4.1–4.2). `userVisibleOnly: true` is required by Chrome/Edge and effectively by Firefox (MDN `PushManager.subscribe`).

### Step 1 — cron scan (every minute)

An Alchemy v2 cron trigger fires the Worker's `scheduled(controller, env, ctx)` handler (Cloudflare Workers *Scheduled Handler* doc). It scans D1 for reminders whose `fireAt` is due and that have no delivered/responded dispatch record. (`* * * * *` matches FR-REM-02 "Cron job every minute scans due undelivered reminders.")

### Step 2 — build the payload

Keep it **small** — a pointer, not the reminder body (see §7):

```json
{ "type": "reminder", "id": "rem_123", "title": "Take medication",
  "body": "Ibuprofen 400mg", "tier": "medication",
  "actions": [ { "action": "done", "title": "Done" },
               { "action": "snooze", "title": "Snooze" } ] }
```

`web-push` warns that additional JWT claims should be kept minimal (RFC 8292 §2.2); the *payload* is separately size-limited only by the push service (RFC 8030 §7.2: services MAY 413 anything over 4096 bytes — keep well under).

### Step 3 — per-subscription send

For each subscription of the target user(s):

1. Derive `audience` = origin of `subscription.endpoint` (`new URL(endpoint).origin`).
2. Mint the VAPID JWT (`aud: audience`, `exp: +12h`, `sub: mailto`), sign ES256 with the stored private key.
3. Encrypt the JSON payload with `keys.p256dh` + `keys.auth`, `aes128gcm`.
4. `fetch(endpoint, { method: 'POST', cache: 'no-store', body, headers })` with:

```
TTL: <seconds>                 # REQUIRED (RFC 8030 §5.2) — 400 if omitted
Content-Encoding: aes128gcm
Content-Type: application/octet-stream
Authorization: vapid t=<jwt>, k=<pub>
Urgency: high                  # medication → high; general → normal
Topic: <≤32 base64url chars>   # optional, coalesces duplicate notifications
```

5. On `2xx`, write the dispatch ledger row (`ReminderDispatch`) as *accepted*.

### Step 4 — map responses to actions

| Response | Meaning | Action |
| --- | --- | --- |
| `201 Created` / `202 Accepted` | accepted (not "delivered") | ledger = dispatched; stop |
| `400 Bad Request` | malformed (missing TTL, bad topic/urgency, bad keys) | **don't retry same message**; log/alert |
| `401` / `403` | VAPID auth missing/invalid (RFC 8292 §4.2) | key/config bug or rotated key; stop and alert |
| `404 Not Found` | subscription expired/removed (RFC 8030 §7.3) | **delete subscription**, mark for re-register |
| `410 Gone` | message unacknowledged after retries | treat as undelivered → inbox fallback |
| `413` | payload too large | shrink payload; don't retry |
| `429` | rate-limited | back off and retry |
| `5xx` / network error / timeout | transient | retry with backoff |

---

## 5. Retry and backoff

Web Push has **no guaranteed-delivery** primitive; reliability is layered:

- **The push service retries for you** — it stores the message and "SHOULD continue to retry delivery of the message until its advertised expiration" (TTL) (RFC 8030 §6.2). So the `TTL` header is effectively the delivery window for an offline/browser-closed receiver.
- **Application-level retry** applies only to *transient* transport failures. For a Worker, use Effect's `Retry`/`Schedule` combinators (exponential backoff + jitter) around the `fetch`, bounded by the cron invocation's 15-minute duration limit. Don't retry `4xx` (permanent), `404`/`410` (dead subscription), or `413`.
- **Receipts are optional and awkward here.** RFC 8030 §5.1 defines `Prefer: respond-async` delivery receipts, but `web-push` does not surface them, and `TTL: 0` messages can't produce receipts (§5.2). Given the missed-reminder inbox already exists, receipts are not worth building.

Practical rule: a reminder fires → dispatch with `TTL` sized to the "missed" horizon (see §7) → record in the ledger → done. The inbox, not push retries, is the recovery path.

---

## 6. Service-worker event handling

### `push` event

```js
self.addEventListener("push", (event) => {
  let msg = event.data?.json();
  event.waitUntil(
    self.registration.showNotification(msg.title, {
      body: msg.body,
      tag: `reminder:${msg.id}`,        // coalesce re-deliveries
      data: msg,                         // survives into notificationclick
      actions: msg.actions,              // Done / Snooze / Dismiss
      requireInteraction: msg.tier === "medication", // sticky until acted on
      dir: "rtl",                        // Persian titles/body
    })
  );
});
```

- The `push` event fires in the service worker whether or not the page is open (MDN `push` event).
- `event.waitUntil(...)` keeps the worker alive until `showNotification` resolves; `showNotification` must be called on `self.registration` from within a user-visible push (MDN `Push API`).
- `data` (an arbitrary JSON blob) is stored on the notification and read back in `notificationclick`.

### `notificationclick` event + action buttons

```js
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { id } = event.notification.data;
  const action = event.action;   // "done" | "snooze" | "dismiss" | "" (body tap)

  if (action) {
    event.waitUntil(enqueueReminderResponse({ id, action })); // → outbox (below)
  } else {
    event.waitUntil(openApp(`/reminders/${id}`));             // body tap → open inbox
  }
});
```

- `event.action` holds the clicked button's `action` string; an empty string means the body was clicked (MDN `notificationclick`).
- Action buttons are declared in `showNotification`'s `actions` option (`{ action, title, icon }`), limited by `Notification.maxActions`, and are only available on **persistent** (service-worker) notifications (MDN `Notification.actions`). A `navigate` option on an action would instead navigate to a URL and skip the event — we don't use it because we need the outbox write.
- **iOS caveat:** action buttons on Web Push notifications are not reliably shown by Safari on iOS. Always mirror Done/Snooze/Dismiss as in-app actions in the missed inbox (§7), so the buttons are a convenience, not the only path.

### Wiring action buttons to the outbox

FR-REM-03 says "Notification action buttons wired to outbox" with "Optimistic state update." The outbox is the local-first IndexedDB queue that `POST /sync/push` later flushes. A service worker can read/write IndexedDB, so on an action click the SW **enqueues a `ReminderResponse` command into the same outbox DB** (and/or `postMessage`s it to any open window so the Solid store updates optimistically), then registers a background sync. This keeps the tap durable and offline-capable, and it goes through the normal reconcile path rather than a one-off `fetch`. Do **not** `fetch()` a response endpoint directly from the SW — that bypasses the outbox and breaks offline semantics.

---

## 7. "Browser closed" fallback — the missed-reminder inbox

The push model behaves like this when the browser is closed:

- App page closed but browser running → the service worker still receives the push and shows the notification (MDN Push API: "whether or not the web app is in the foreground, or even currently loaded").
- **Browser fully quit** (desktop) → the push service stores the message up to its `TTL` and delivers when the browser reconnects (RFC 8030 §5.2, §7.2). If `TTL` expires first, the message is dropped (§5.2: "Once the TTL period elapses, the push service MUST NOT attempt to deliver").
- Mobile → push rides the OS-level push channel and can wake/show the app even with the browser closed (varies by platform).

**Implications for Tali (matches FR-REM-02 "browser closed" acceptance):**

1. **The dispatch ledger is authoritative, not the push.** A reminder "happened" when its `fireAt` passed and it was scanned — regardless of whether the push reached a live browser. Record every dispatch (accepted / rejected / undelivered) in `ReminderDispatch`.
2. **The missed-reminder inbox is derived from the ledger**, not from client state. On next app open, `GET` the inbox query (`/reminders` "missed inbox") and show every reminder whose dispatch has no response — the "Missed reminders appear in inbox instead of vanishing" acceptance criterion.
3. **Keep `TTL` meaningful but bounded.** A medication reminder's value decays fast; a very long `TTL` risks a 4-hours-late "take your meds" alert when the browser reopens. Prefer: `TTL` ~ the snooze/quiet-hours window (or short, e.g. 1h), and let the *inbox* carry anything the push missed. Never set `TTL: 0` if you want the closed-browser recovery, since a zero-TTL message to an unavailable UA "expires and is never delivered" (RFC 8030 §5.2).
4. **Push payload stays a pointer.** Because the real recovery is "app opens → syncs → reads inbox from ledger," the push only needs the reminder id/title/actions for the immediate notification. The full reminder state is already in D1 and re-synced on open.

---

## 8. Tali-specific notes and open questions

- **Installed-PWA prerequisite.** Web Push requires a secure context, and on iOS Safari (16.4+) the site must be **added to the Home Screen** as a PWA before it can subscribe. The feature map's "installed PWA" exit criterion is therefore a hard dependency for the medication-reminder slice, not just polish.
- **Push endpoint is a capability URL — keep it secret.** Knowledge of the endpoint alone lets anyone send notifications (MDN Push API). VAPID restriction (RFC 8292 §4) mitigates this, but store subscriptions server-side only, never expose them to other clients, and rotate by unsubscribing/resubscribing if leaked.
- **`pushsubscriptionchange`** must be handled in the SW: when the browser rotates the subscription, re-`subscribe()` and re-`POST /push/register` so D1 doesn't hold a dead endpoint (MDN Push API).
- **Concurrency/idempotency across cron ticks.** Cron invocations can overlap (and a scan may re-see a due-but-undispatched reminder). Mark reminders as `dispatching` atomically (or use a `UNIQUE` idempotency key on the ledger) so a reminder is never double-sent.
- **Effect layering.** This is one typed gateway service (`NotificationService` / `PushGateway`) taking `(subscriptions, reminder) → Effect<DispatchOutcome, PushError>` — with the VAPID signer and the aes128gcm encryptor behind interfaces so they're fake-able in tests (feature map: "Layers make … the push gateway … composable and testable with fake implementations"). The exact `Effect` retry/schedule shapes should be confirmed against `@repos/effect/` examples.

### Not yet specified (for the map's fog list)

- Whether the dispatch scan runs in a cron Worker or a Durable Object alarm (for exactly-once + long-run fan-out beyond 2 users).
- Whether to persist VAPID keys per-environment (prod vs preview) and rotate on preview builds.

---

## 9. Sources (primary)

- **RFC 8292** — *Voluntary Application Server Identification (VAPID) for Web Push* — key gen (§2), JWT claims aud/exp/sub (§2), `vapid t=…,k=…` scheme (§3), subscription restriction (§4). https://www.rfc-editor.org/rfc/rfc8292.html
- **RFC 8030** — *Generic Event Delivery Using HTTP Push* — actors (§2), delivery request + TTL (§5.2), urgency (§5.3), topic/replacement (§5.4), acknowledgement + retry (§6.2), expiration/404 (§7.2–7.3), size limits (§7.2), security/TLS + E2E encryption (§8). https://www.rfc-editor.org/rfc/rfc8030.html
- **RFC 8291** — *Message Encryption for Web Push* — `aes128gcm` payload encryption (referenced by RFC 8030 §8.1 as the W3C-adopted scheme). https://www.rfc-editor.org/rfc/rfc8291.html
- **web-push** (web-push-libs/web-push) — `generateVAPIDKeys` (P-256, padding), `getVapidHeaders` (JWT ES256, 12h/24h expiry, localhost subject warning), `generateRequestDetails`/`sendNotification` (aes128gcm default, header assembly, status handling). https://github.com/web-push-libs/web-push
- **MDN — Push API** (subscription = endpoint + keys, capability-URL secrecy, `pushsubscriptionchange`). https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- **MDN — `PushManager.subscribe()`** (`userVisibleOnly`, `applicationServerKey` = VAPID key, user-gesture requirement). https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe
- **MDN — `PushSubscription.toJSON()`** (`endpoint`, `expirationTime`, `keys`). https://developer.mozilla.org/en-US/docs/Web/API/PushSubscription/toJSON
- **MDN — `push` event** (service worker, `event.data`, `showNotification`). https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/push_event
- **MDN — `notificationclick` event** (`event.action`, `clients.openWindow`, `waitUntil`). https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/notificationclick_event
- **MDN — `Notification.actions`** (buttons, persistent-only, `maxActions`, `navigate`). https://developer.mozilla.org/en-US/docs/Web/API/Notification/actions
- **Cloudflare Workers — Secrets** (encrypted storage, `wrangler secret put`, `.dev.vars`). https://developers.cloudflare.com/workers/configuration/secrets/
- **Cloudflare Workers — Fetch** (outbound subrequests from a handler, `cache: 'no-store'`). https://developers.cloudflare.com/workers/runtime-apis/fetch/
- **Cloudflare Workers — Scheduled Handler** (cron triggers, `scheduled()`, `ctx.waitUntil`, 15-min limit). https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
