# Review — Item 02: Auth hot path: stop writing on every read

- Branch: `perf/latency-p0`
- Base: `6b0999323`
- Head: `051acc14c` (`perf(api): stop writing the session row on every authenticated request`)
- Files changed: `apps/api/src/auth-service.ts` (+64/−25), `apps/api/src/auth-routes.ts` (+8/−4), `apps/api/test/boundary/auth.boundary.test.ts` (+79/−11)
- Verdict: **approve with nits** (one `should-fix`)

The core change is correct and does exactly what the brief asks: `AuthService.me()`
is now read-only (`resolveSession(false)`), the hot read path no longer performs a
D1 write, and `GET /auth/me` slides the row and re-stamps the cookie together,
only when the remaining lifetime is below the 7-day threshold. The `/auth/me`
body shape (`{ user, householdId }`) and `cache-control: no-store` are unchanged,
expired/unknown-token behavior (delete + `Unauthorized`) is preserved, and the
boundary tests exercise exactly the fixed behavior.

There is one genuine divergence the split introduced that the brief's own
"keep the row and cookie in step" rule flags: the three *mutation* routes that
still re-stamp the cookie no longer extend the row (§1 below). It is a narrow,
non-security correctness regression, so I am not blocking the item, but it
should be fixed before Item 03 lands.

---

## Findings

### 1. Cookie re-stamped but row no longer extended on the three mutation routes — `should-fix`

`apps/api/src/auth-routes.ts:153,156` (change-password), `:220,223` (household), `:241,244` (join); `apps/api/src/auth-service.ts:252-253`

`authenticate(request)` resolves the principal through `auth.me(token)`, which is
now read-only (`resolveSession(false)`, `auth-service.ts:252`). But these three
routes still unconditionally re-stamp the cookie with a fresh 30-day `maxAge`
via `setSession(response, token, request)`:

```ts
// change-password
const { token, context } = yield* authenticate(request)          // read-only
...
return setSession(yield* json(200, { ok: true }), token, request) // cookie → now+30d, row untouched
```

Before this commit, `me()` ran `sessions.extend(...)` on every call, so these
routes extended the row **and** re-stamped the cookie — both 30 days, in step.
After this commit the cookie is extended while the row keeps its original
`expires_at`. The cookie now outlives the row.

Concrete scenario: login at day 0 (row and cookie both expire day 30). At day 20
the user creates a household. The cookie is re-stamped to day 50, but the row
still expires day 30. At day 31 the browser still holds a non-expired cookie, yet
`/auth/me` finds the row expired, deletes it, and returns 401 — the user is
signed out while their browser still presents a valid-looking session cookie.

This is the reverse of the divergence the plan itself calls out ("Extending the
DB row without re-setting the cookie is rejected") — here the cookie is re-set
without extending the row. No security impact (the row is the gatekeeper and is
only ever *shortened* relative to the cookie), but it breaks the "active
household keeps its session" promise for three infrequent-yet-important actions.

Fix options (for the implementer): (a) have these routes extend the row in the
same request when they re-stamp — they are already write paths, so one extra
`UPDATE` costs nothing against the P0 goal — or (b) stop re-stamping the cookie
on these routes and let `/auth/me` own sliding. The current `join` test only
asserts `sessionCookieOf(join)` is defined (`auth.boundary.test.ts:258`), so no
test catches the missing row extension; a near-expiry assertion here would.

### 2. Malformed `expires_at` is treated as a never-expiring session — `nit` (pre-existing)

`apps/api/src/auth-service.ts:225-230`

`Date.parse(session.expiresAt)` returns `NaN` for an unparseable value, and both
guards then treat the row as valid: `NaN <= now` is `false` (not expired) and
`NaN < SESSION_RENEW_THRESHOLD_MS` is `false` (not renewed). A row with a
malformed `expires_at` is therefore accepted indefinitely and never slid. This is
**unchanged** from the old code, which had the identical `Date.parse(...) <= now`
guard, so it is not a regression introduced by this item — flagging it only
because the review brief asks about it. Worth a separate hardening ticket (e.g.
`Number.isNaN` → treat as expired/delete), not this P0 item.

### 3. Commit message vs. the plan's specified message — `nit`

The plan (`docs/plans/latency-fixes/PLAN.md:130`) specifies the commit message
`perf(api): renew the session only when it is close to expiry`. The head commit
is titled `perf(api): stop writing the session row on every authenticated
request`, which describes option A ("stop writing") while the code implements
option B (threshold sliding + cookie re-stamp). The message is still accurate —
it *does* stop writing on every request — but it undersells the renewal half and
does not match the plan verbatim. Cosmetic only.

---

## Verification

Commands run from `/home/ronin/Projects/tali` (no deploy, no dev servers, no push).

### `pnpm --filter @tali/api test`

```
$ vitest run

 RUN  v5.0.4 /home/ronin/Projects/tali/apps/api

 Test Files  38 passed (38)
      Tests  381 passed (381)
   Start at  15:58:02
   Duration  3.58s (transform 44%, import 26%, tests 18%, setup 12%, worker 1%)
```

All 38 files / 381 tests pass. The new `auth.boundary.test.ts` cases run in the
`boundary` project: `vitest.config.ts:41` includes `test/boundary/**/*.test.ts`,
so the four new `GET /auth/me` cases are actually executed by this command.

### `pnpm --filter @tali/api typecheck` (fresh, uncached, the changed package)

```
$ tsc --noEmit
EXIT: 0
```

No output, no errors — no type escapes, `Option`/`toUserProfile` still used, the
`resolveSession` refactor typechecks against `SessionRepo.extend` unchanged.

### `pnpm typecheck` (whole repo)

```
$ turbo run typecheck
 Tasks:    10 successful, 10 total
Cached:    10 cached, 10 total
  Time:    9ms >>> FULL TURBO
```

### `git diff --check 6b0999323..051acc14c`

```
EXIT: 0
```

No whitespace errors.

---

## What I verified

- **Semantics.** `me()` keeps its exact `(token) => Effect<SessionContext, Unauthorized>`
  contract (`auth-service.ts:252-253`), so every existing caller is unaffected in
  shape: `sync.ts:93`, `rpc-handlers.ts:55` (RPC viewer), `today-routes.ts:51`,
  `calendar-routes.ts:69`, `push-routes.ts:86`, `reminder-routes.ts:56`,
  `note-search-routes.ts:44`, `preferences-routes.ts:64`, and `authenticate`
  (`auth-routes.ts:94`). Each now gets a read-only resolution — the intended
  perf win. `GET /auth/me` returns the same `{ user, householdId }` body, and
  `json()` still sets `cache-control: no-store` on both the renewed and plain
  responses, so the 200 is no more cacheable than before.
- **Cookie/DB alignment on the renewal path.** `SESSION_MAX_AGE = "30 days"`
  (`auth-routes.ts:30`) = 2,592,000s = `SESSION_TTL_MS` (30d). The renewal path
  extends the row by 30d and re-stamps the cookie by 30d in the same response,
  gated on the same `renewed` flag (`auth-service.ts:230-235`, `auth-routes.ts:204`),
  so the two move in step. The near-expiry test asserts `maxAgeOf(setCookie) ===
  30*24*60*60` (`auth.boundary.test.ts:156`), pinning the "30 days" → seconds
  serialization. The one divergence is §1 (mutation routes), covered above.
- **Expiry edge cases.** Expired → `expiresAt <= now` deletes the row and fails
  `Unauthorized` (`auth-service.ts:226-229`), no `Set-Cookie` on the 401 path —
  tested at `auth.boundary.test.ts:159-170`. Exactly-at-threshold: the strict
  `<` (`auth-service.ts:230`) means exactly 7 days remaining does **not** renew,
  matching the plan's "below 7 days". Concurrent near-expiry requests are
  idempotent (no token rotation, both `extend` to ~now+30d) — no race.
- **Security.** No token rotation (the re-stamp reuses the same token; asserted
  at `auth.boundary.test.ts:155`), no session fixation (tokens are random at
  mint and unchanged), no cross-user context (`toUserProfile(user)` from the
  session's own `userId`). `Set-Cookie` is emitted only on the renewal path
  (`auth-routes.ts:204`) — never on a plain 200 read.
- **Tests.** The fresh-session test (`auth.boundary.test.ts:96-118`) and the
  20-day test (`:120-134`) would both fail on the old code: the old `me()`
  called `extend` (row `expires_at` → now+30d) and re-stamped the cookie on
  every `/auth/me`, so `expiresAtOf(...) === before/pinned` and
  `sessionCookieOf(...) === undefined` would not hold. The 20-day test is
  meaningful because the pinned value (now+20d) differs from `extend`'s now+30d,
  so the old code would observably change the row no matter how fast the two
  calls run. Test isolation: each case registers a unique user
  (`crypto.randomUUID()` email → unique `user_id`), and `expiresAtOf`/`setExpiresAt`
  filter by `user_id`, so mutating `sessions` directly does not leak across
  cases (confirmed by the clean 381-test run).
- **Scope/style.** Only the three owned files changed; `packages/sql` was not
  touched (no repo helper was needed). Comments on `me`/`meWithRenewal`/
  `resolveSession`/`SESSION_RENEW_THRESHOLD_MS` are accurate. No `as any` or
  type escape in the diff; `git diff --check` is clean.

## What I could not verify without a deploy

- **`secure` flag behind the proxy.** `setSession` derives `secure` from
  `request.url.startsWith("https://")` (`auth-routes.ts:84`), and the renewal
  path reuses it unchanged. That the deployed Worker (fronted by Cloudflare)
  sees an `https://` origin and therefore sets `Secure` is pre-existing
  behaviour and is not observable in the local harness (which fetches over
  `http://localhost`, so `secure: false` in tests). No change here, but the
  production `Secure`-flag behaviour was not and cannot be re-verified locally.
- **Actual latency win magnitude.** Removing one `UPDATE sessions` per read is
  sound, but the wall-clock improvement against the measured baseline
  (`/auth/me` = 4 D1 statements including a write) is only confirmable with the
  synthesis' measurement harness after deploy.
- **§1 divergence in production.** The exact re-login timing impact of the
  mutation-route divergence depends on real usage of change-password /
  household / join near a session boundary; the code path is clear, the user
  impact is not measurable locally.
