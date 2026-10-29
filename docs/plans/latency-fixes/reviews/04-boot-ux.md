# Review — P0-04 Boot and navigation UX

- **Base:** `8c887fdb1`
- **Head:** `431046b25` (`perf(web): boot from the cached session and remove the navigation splash`)
- **Verdict:** changes requested

One `should-fix` in the auth path: the optimistic boot makes the app (and the
sign-out button) interactive while the boot `/auth/me` is still in flight, and a
late `200` can re-apply the session after `signOut`/`clearSession`, leaving the
user signed in against a revoked cookie. It is not cross-user data exposure and
the server still enforces the cookie, so it is not a blocker, but it is a real
state-consistency regression versus the old guarded boot. Everything else checks
out: the cached boot paints the shell before the network settles, no in-app
navigation shows the full-screen splash, the entry chunk grows by ~1.5 kB gzip,
and the new tests fail on the old code (3 of 4).

---

## 1. Auth correctness / security

**Boot trace (cached session).** `AuthProvider` seeds `status`/`session`
synchronously from `readCachedSession()` (`auth.tsx:59-63`) and `refresh()`
(`auth.tsx:90-111`) reconciles `/auth/me` in the background. The guard
(`guard.tsx:24-47`) reads `status()`, so a cached session renders the route on
the very first paint and `BootScreen`/`Splash` never appears.

- **Cached user A, server `Unauthorized`.** `refresh()`'s `Unauthorized` branch
  (`auth.tsx:99-101`) calls `clearSession()` → `clearCachedSession()` +
  `setSession(undefined)` + `setStatus("signedOut")` (`auth.tsx:73-78`). The
  guard then redirects to `/login`. The window in which A's local mirror was
  painted is A's *own* data on A's *own* device (the mirror is keyed by
  `tali.mirror.v1.<userId>`, `store.ts:36`), so this is the intended optimistic
  behaviour, not a leak.
- **"Cached user B on the same device".** The session cache is a *single* slot —
  one `localStorage` key, `tali.session.v1` (`session-cache.ts:15`), overwritten
  by every `applySession` (`auth.tsx:66-71`) and cleared on sign-out and
  `Unauthorized`. There is no state where two users' sessions are cached
  simultaneously, and the IndexedDB mirror is keyed off `auth.session()?.user.id`
  (`context.tsx:187`). The only way cache says A while the cookie says B is a
  cross-tab hand-off (pre-existing, orthogonal to this diff), not something this
  change introduces.
- **`clearSession` / per-user store.** `clearSession` closes the mirror via the
  `LocalStoreProvider` effect cleanup (`context.tsx:223` → `closeStore()`), which
  bumps `generation` and closes the IndexedDB connection, so a stale mirror does
  not stay open after `Unauthorized`. The mirror *data* is intentionally retained
  on disk (`store.ts:20-22`) but is never rendered once `status` leaves
  `signedIn`.
- **`readCachedSession()` invocation.** Called exactly once, at the top of the
  `AuthProvider` body (`auth.tsx:59`) — a provider function body runs once. It is
  browser-safe: `storage()` returns `undefined` when `localStorage` is absent
  (`session-cache.ts:17-25`), which also covers the Vite prerender (`vite.config.ts`
  prerenders the shell to static `dist/client`), so it no-ops to `undefined`
  outside the browser.

**`should-fix` — a late `/auth/me` 200 re-applies a session after sign-out.**
`refresh()` captures `session()` at call time but has **no generation/epoch
guard**: once the request resolves, `if (result.ok) applySession(result.value)`
(`auth.tsx:95-97`) runs unconditionally. The optimistic boot now renders the full
app — including the header's "خروج" button (`app-header.tsx:135-142`) — while the
boot `refresh()` is still awaiting `/auth/me`. So:

1. Cached session A seeds `signedIn`; boot `refresh()` dispatches `/auth/me`.
2. The user clicks sign-out → `signOut()` (`auth.tsx:148-154`) POSTs logout, then
   `clearSession()` → `signedOut`, guard redirects to `/login`.
3. The in-flight `/auth/me` (up to `REQUEST_TIMEOUT_MS = 15_000`,
   `auth-api.ts:30`) resolves `200` *after* the logout settled → `applySession`
   re-caches and re-applies A, `status` flips back to `signedIn`, the guard
   redirects back to `/today`, and `LocalStoreProvider` re-opens A's mirror.

There is no later `/auth/me` to clear it (`onSettled` already ran), and a sync
`401` only sets `halted` on the local store (`context.tsx:130-132,177`) — it does
not call `auth.clearSession()`. The result is a **persistent signed-in state
against a revoked cookie** until the user signs out again. The old code was not
reachable this way because `refresh()` forced `status = "checking"`, which kept
the full-screen splash up and the sign-out button unmounted for the whole boot.
A one-line epoch/generation counter that `clearSession`/`applySession` advance,
checked before `applySession(result.value)`, closes it.

## 2. Refresh races

- **Boot + retry double call.** `onSettled(() => void refresh())`
  (`auth.tsx:115-117`) fires once per `AuthProvider` mount. The retry button
  (`boot.tsx:24-28`) only renders when `status === "error"`, which requires *no*
  cache, so boot-with-cache never exposes a concurrent retry. `auth.refresh()` is
  also called from `household.tsx:109,209` only after an `AlreadyInHousehold`
  error, and from `push/context.tsx` via a *different* `refresh`. No path calls
  the auth `refresh()` concurrently today, and the new test asserts one
  `/auth/me` per boot (§5).
- **Sign-in during boot.** Not reachable: a cached session is `signedIn`, so
  `guest` routes redirect away (`guard.tsx:28-38`), and a no-cache boot shows the
  full-screen splash with no login affordance. Only the sign-out race in §1 is
  reachable.
- **vs. old guarded behaviour.** Old `refresh()` set `status("checking")` first
  and re-read `readCachedSession()` only in the failure branch; it could not
  re-apply after sign-out because sign-out was unreachable during boot. The new
  code is strictly more permissive and needs the epoch guard.

## 3. Boot / splash

- **No full-screen splash on in-app navigation.** The router's `Loading` fallback
  is now `RouteSkeleton` (`App.tsx:27`); `Splash` remains in use only by
  `BootScreen` (`boot.tsx:16-32`), which is the `Guard` fallback for the no-cache
  first boot (`guard.tsx:43`). During in-app navigation `status` stays `signedIn`,
  so `Guard` renders immediately and the `Loading` boundary shows the wireframe
  while the lazy route chunk resolves. Confirmed no path reuses `Splash` for
  navigation.
- **`RouteSkeleton` fidelity.** It mirrors the header's `padding: 10px
  clamp(14px, 3vw, 24px)` and the `min(100%, 1200px)` inner width
  (`boot.tsx:72-84`) against `app-header.tsx:109-112` and
  `base.css:176-181`, and uses `tokens.color.{canvas,line,surface,ink}`,
  `tokens.radius.md`, `tokens.font.sans`. Two small mismatches: the real header
  drops `padding-inline` to `12px` under 540px (`base.css:299-302`) while the
  skeleton keeps `clamp(...)`, and the skeleton omits the header's
  `box-shadow`/`backdrop-filter` (`base.css:172-173`). Cosmetic only — no content
  layout shift, since the nav pills' `min-block-size: 38px` matches
  `base.css:226`.
- **Accessibility.** `role="status"` + `aria-busy="true"` + `aria-label` are
  present (`boot.tsx:58-60`). `role="status"` is a polite live region but its
  announced content is its *text*, which is empty here (all placeholder divs), so
  the loading state may not be announced verbatim; a visually-hidden "در حال
  بارگذاری" text would make it robust. `nit`.

## 4. Prefetch — confirmed against the installed router

Installed `@solidjs/router` is `2.0.0-next.40` (declared `^2.0.0-next.38`).
`createRouter({ preloadLinks: intentPreload() })` (`router.ts:10-13`) installs the
strategy via `setupNativeEvents` (`dist/index.js` `preload: config.preloadLinks`).

- **Chunks warm on intent, not eagerly.** `intentPreload` (`dist/preload.js`)
  adds `focusin`/`touchstart`/`mousemove` listeners (20 ms hover dwell) and calls
  `ctx.preload(url, data)` → `preloadRoute`, which resolves the lazy file-route
  subtree (`resolveLazySubtree`) and `component?.preload?.()`. It does **not**
  attach a `click` listener, so it cannot double-navigate; the header's `go()`
  still `preventDefault()` + `navigate(href)` (`app-header.tsx:101-104,161-169`),
  and the router's delegated click handler bails on `defaultPrevented`
  (`dist/index.js` `handleAnchor`).
- **No external/eager prefetch.** `anchorUrl` skips `target`, `download`,
  `rel="external"`, non-http(s) schemes, and `url.origin !==
  window.location.origin` (`dist/index.js` `anchorUrl`); only the eight internal
  nav links match, and only on intent.
- **No route data fetch today.** `intentPreload()` defaults to `data: true`, which
  runs matched routes' `preload` functions (`dist/preloadRoute.js`). No route in
  `apps/web/src/routes/*` exports a `preload` and none is a server-component
  route (`grep` over the routes finds no `export ... preload`), so this warms code
  only and hits nothing. `nit`: `intentPreload({ data: false })` would match the
  plan's "prefetch route chunks" wording more literally and guard against a future
  route data loader silently prefetching on hover.

## 5. Tests — confirmed

`apps/web/src/lib/auth.test.tsx` exercises the **real** `AuthProvider` and the
real `auth-api` (`send` → `fetch`, schema decode, `classify`) by stubbing only
`globalThis.fetch`; the `Probe` stands in for `Guard` with the same
`householdId` gate. No mock of the provider itself.

- **Fails on old code.** Running the suite against `8c887fdb1` (implementation
  files at base, test retained): **3 of 4 tests fail** — "renders guarded content
  from the cached session…", "clears the cached session on `Unauthorized`", and
  "restores exactly one `/auth/me`" all hit `expected 'signedIn', received
  'checking'` (old code seeds `checking`). Only the network-failure test passes on
  old code (it documents the pre-existing offline fallback).
- **Deterministic.** No real timers and no network: `me()` is a
  `deferredResponse` or an immediate `Response`; `waitFor` is the only polling;
  `AbortSignal.timeout` in `auth-api` merely creates a signal that never fires.
  `localStorage.clear()` in `beforeEach`; `meCalls` reset in `beforeEach`;
  `globalThis.fetch` restored in `afterEach`. `authApi` holds no module state, so
  there is nothing else to reset (`isolate: false` is safe here).
- **Single-call assertion.** The `meCalls === 1` check after `waitFor` plus two
  microtasks confirms `onSettled` triggered exactly one `refresh` and nothing
  immediately re-fires it. It would not catch a later `setTimeout`-scheduled
  duplicate, but nothing schedules one; the assertion is meaningful for the
  duplicate-boot question it targets.

## 6. Scope / style / build

Only the five owned files changed (`App.tsx`, `components/boot.tsx`,
`lib/auth.tsx`, `router.ts`, `lib/auth.test.tsx`); no API/sync/push source
changes, no `package.json`/`pnpm-lock.yaml` change, no new dependency.
`git diff --check` is clean. Revertable alone (web-only, no schema/cookie/API
surface).

**Entry growth.** Compared a `--filter @tali/web build` at base vs head:

| Chunk | Base | Head | Δ |
| --- | --- | --- | --- |
| entry-client | 42.08 kB (14.27 gzip) | 45.66 kB (15.76 gzip) | **+3.58 kB (+1.49 gzip)** |
| routing | 255.15 kB (85.69 gzip) | 255.99 kB (85.98 gzip) | +0.84 kB (+0.29 gzip) |

The `intentPreload` listeners land in the entry chunk; the delta is ~1.5 kB gzip —
immaterial against the plan's "entry payload does not grow materially".

---

## Commands and results

```
$ pnpm --filter @tali/web test
 Test Files  37 passed (37)
      Tests  271 passed (271)
   Duration  3.18s
```

```
$ pnpm typecheck
 Tasks:    10 successful, 10 total
 Cached:    10 cached, 10 total
```

```
$ pnpm --filter @tali/web build
 dist/client/assets/virtual_solid-ssr-entry-client-Bvg4SVPg.js   45.66 kB │ gzip: 15.76 kB
 dist/client/assets/routing-BiB62SoU.js                         255.99 kB │ gzip: 85.98 kB
 ✓ built in 431ms  (client)  /  ✓ built in 17ms  (ssr)
```

```
$ git diff --check 8c887fdb1..431046b25
 EXIT: 0   (no output)
```

## Could not be verified

- **Wall-clock boot-to-interactive.** Acceptance is a paint-before-network
  guarantee; I confirmed the code path (synchronous seed + guard renders
  immediately) but did not run a browser or dev server, so no measured
  boot-to-interactive number.
- **Live cross-user/cross-tab hand-off.** The single-slot localStorage cache and
  per-user mirror make a same-tab cross-user flash impossible in normal flows; a
  cross-tab cookie/localStorage divergence is pre-existing and was reasoned, not
  exercised.
- **Sign-out race timing.** The §1 race is a logical interleaving (boot `/auth/me`
  in flight while `signOut` settles); I did not reproduce it against a live slow
  server. The epoch guard is the standard fix regardless of observed frequency.
