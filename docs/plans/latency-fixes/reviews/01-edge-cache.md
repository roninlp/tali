# Review — Item 01: Edge placement + asset caching

- Branch: `perf/latency-p0`
- Base: `3015d0696`
- Head: `9e4067763` (`perf(infra): place api near d1 and cache hashed assets`)
- Files changed: `infra/alchemy.run.ts` (+8 / −1)
- Verdict: **approve with nits**

The change is correct, minimal, and does exactly what the brief asks: it adds
`placement: { mode: "smart" }` to the `TaliApi` Worker and an immutable
`Cache-Control` rule for `/assets/*` on the `TaliWeb` StaticSite. Both props are
accepted by the installed Alchemy types, the config shape matches Cloudflare's
API, and nothing in the runtime path regresses. The findings below are
informational nits, not blockers.

---

## Findings

### 1. `placement: { mode: "smart" }` — correct type and shape — `nit` (confirmatory)

`infra/alchemy.run.ts:171`

The prop is accepted by the installed Alchemy type. `WorkerPlacement`
(`alchemy/src/Cloudflare/Workers/Worker.ts:102`) is
`Exclude<PutScriptRequest["metadata"]["placement"], undefined>`, which resolves
to `PutScriptMetadataPlacement` — a union whose `PutScriptPlacementSmart` member
is exactly `{ mode: "smart" }` (`@distilled.cloud/cloudflare` `workers.ts:11311-11321`).
Alchemy passes `props.placement` straight into the script-upload metadata
(`WorkerProvider.ts:1114`, `3814`), so `{ mode: "smart" }` reaches Cloudflare as
`metadata.placement` unchanged.

`mode: "smart"` is mutually exclusive with `region`/`host`/`hostname` per the
Cloudflare Placement docs; the brief's choice of `smart` over an explicit
`region` is the right call here (see §4 below). No type escape, no cast.

### 2. `headers` is raw `_headers` content and the syntax is valid — `nit` (confirmatory)

`infra/alchemy.run.ts:226-227`

`AssetsConfig.headers` is `string` typed as "Raw contents of a `_headers` file —
header rules applied by the asset layer. Overrides a `_headers` file read from
the assets directory" (`Assets.ts:74`). The value

```
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

is a valid Cloudflare `_headers` rule: a path on its own line (starting with
`/`), one header indented two spaces, `Name: value`. `max-age=31536000` (1y) and
`immutable` (RFC 8246) are both valid `Cache-Control` directives, and `public`
is fine. `StaticSite`'s `assets` prop is `AssetsConfig` (`StaticSite.ts:32`), so
the `headers` string is correctly typed and typechecks.

### 3. `headers` prop does not silently override a needed `_headers` file — `nit`

`infra/alchemy.run.ts:226`

`mergeAssetsConfigFiles` (`Assets.ts:263-277`) resolves
`config.headers ?? files._headers`, i.e. an explicit `headers` prop **wins over**
any `_headers` file in the assets directory. There is currently no `_headers`
(and no `_redirects`) file anywhere in the repo (`apps/web/public/` contains only
`icons/`, `manifest.webmanifest`, `sw.js`; a repo-wide search found none), and
Vite does not emit one, so today the prop overrides nothing and no rule is lost.
The latent footgun is that if someone later drops a `_headers` into
`apps/web/public/`, this inline prop will silently shadow it. Recommend a one-line
comment noting that this prop owns the `_headers` rules for the site, so a future
editor knows to merge rather than add a file. (Non-blocking — no file exists
today.)

### 4. Explicit `region` would not be safer; D1's region is not knowable here — `nit`

`infra/alchemy.run.ts:39-41, 171`

The D1 database is created without `primaryLocationHint`, so its primary region
is Cloudflare's default and is not pinned anywhere in the config (confirmed by a
repo-wide grep for `primaryLocationHint`/`primary_location`: no hits). An
explicit `placement.region` would therefore be a guess, and `region` takes the
`{provider}:{region}` form (`aws:us-east-1` …), which does not map 1:1 from D1's
coarse `primaryLocationHint` codes (`wnam`/`enam`/…). `mode: "smart"` is the
correct option precisely because the infra location is not known ahead of time;
it lets Cloudflare colocate the Worker with the D1 primary automatically.

### 5. Placement applies to the API isolate, not to static/health paths — `nit` (confirmatory)

`infra/alchemy.run.ts:171, 215-233`

`placement` is set only on `TaliApi`, and `/api/*` requests enter through
`TaliWeb` (`runWorkerFirst: ["/api/*"]`), whose `apps/web/worker.ts` forwards to
the API Worker via the `API` **service-binding `fetch()`** — a fetch-handler
invocation, not an RPC call. Cloudflare's Placement docs scope placement to
"fetch event handlers" (it does not apply to RPC methods or named entrypoints),
so the API Worker's `fetch` handler is eligible, matching the docs' own
"Multiple Workers … enable placement on your back-end Worker" pattern.

The `TaliWeb` StaticSite itself is **not** placed, and static assets are always
served from the PoP nearest the request, so `/assets/*`, the SPA fallback, and
any health/static request do not pay a placement-related hop. The `/assets/*`
header rule is served by the asset layer (assets-first for non-`/api/*` paths),
so it is unaffected by the Worker placement.

### 6. Immutable rule is safe for `/assets/*`; does not strand users on an old build — `nit` (confirmatory)

`infra/alchemy.run.ts:224-227`

- **Hashed assets** live under `/assets/*` (Vite's default output, `assetsInlineLimit: 0`
  in `apps/web/vite.config.ts:29` forces every asset to a hashed file), so a
  filename is content-addressed and immutable-for-a-year is correct.
- **`index.html`** is at the origin root, not under `/assets/`, and is served via
  `notFoundHandling: "single-page-application"`; it is **not** matched by
  `/assets/*`, so it keeps revalidating. No build-stranding via the shell.
- **`sw.js`**, **`manifest.webmanifest`**, and **`icons/`** are in
  `apps/web/public/` and are copied verbatim to the origin root (`/sw.js`,
  `/manifest.webmanifest`, `/icons/*`) — they are **not** under `/assets/*` and
  are not hashed, so they are correctly excluded from the immutable rule. (This
  matters: an immutably-cached `sw.js` is the classic way to strand a user on an
  old build; the rule correctly avoids it.)

One theoretical edge case: a request for a *missing* hashed asset path (a stale
hash referenced only by an already-old `index.html`) falls through to the SPA
fallback, which serves `index.html`; whether Cloudflare then attaches the
`/assets/*` header to that fallback response is not something I can confirm
without a deploy (see §8). Even if it did, the impact is bounded to a client
already in a broken state, and the served HTML fails to execute as a script due
to MIME-type mismatch. Not a blocker; flagging for completeness.

---

## Verification

Commands run from `/home/ronin/Projects/tali` (no deploy, no `alchemy plan`, no
dev servers):

### `git diff --check 3015d0696..9e4067763`

```
EXIT: 0
```

No whitespace errors.

### `pnpm typecheck`

```
$ turbo run typecheck

   • turbo 2.11.8
   • Packages in scope: @tali/api, @tali/config, @tali/conflict-lab, @tali/domain, @tali/e2e, @tali/infra, @tali/rpc, @tali/sql, @tali/ui, @tali/web
   • Running typecheck in 10 packages
   • Remote caching disabled

@tali/domain:typecheck: cache hit, replaying logs 3dc6134d6b3defdf
@tali/domain:typecheck: $ tsc --noEmit
@tali/config:typecheck: cache hit, replaying logs 1066c40106ee9de5
@tali/config:typecheck: $ tsc --noEmit
@tali/e2e:typecheck: cache hit, replaying logs de8eee3b2d614fe7
@tali/e2e:typecheck: $ tsc --noEmit
@tali/ui:typecheck: cache hit, replaying logs c48c4713867bb349
@tali/ui:typecheck: $ tsc --noEmit
@tali/infra:typecheck: cache hit, replaying logs 7a960fcc8000b405
@tali/rpc:typecheck: cache hit, replaying logs b2c94c0d611d1d08
@tali/infra:typecheck: $ tsc --noEmit
@tali/sql:typecheck: cache hit, replaying logs 3f6c1ae07ec7a9f7
@tali/rpc:typecheck: $ tsc --noEmit
@tali/sql:typecheck: $ tsc --noEmit
@tali/web:typecheck: cache hit, replaying logs 16faf6192cb09f82
@tali/web:typecheck: $ tsc --noEmit
@tali/api:typecheck: cache hit, replaying logs 5558e0fffe222f4a
@tali/api:typecheck: $ tsc --noEmit
@tali/conflict-lab:typecheck: cache hit, replaying logs d5638d77c60b95d8
@tali/conflict-lab:typecheck: $ tsc --noEmit

 Tasks:    10 successful, 10 total
Cached:    10 cached, 10 total
  Time:    8ms >>> FULL TURBO
```

### `pnpm --filter @tali/infra exec tsc --noEmit` (fresh, uncached, the changed package)

```
EXIT: 0
```

No output, no errors — the `placement` and `headers` props typecheck against the
installed Alchemy types (`alchemy@2.0.0-beta.83`).

---

## What I verified

- The exact diff (`git diff 3015d0696..9e4067763`) is confined to
  `infra/alchemy.run.ts` (+8/−1); no runtime Worker code, build, or `/api` proxy
  changed, matching the brief's "only `infra/alchemy.run.ts`" scope.
- `WorkerPlacement` / `PutScriptPlacementSmart` types accept `{ mode: "smart" }`
  exactly, and Alchemy forwards `placement` into `metadata.placement`.
- `AssetsConfig.headers` is raw `_headers` content; the inline string is valid
  `_headers` syntax and correctly excludes `index.html`, `sw.js`,
  `manifest.webmanifest`, and `icons/`.
- No `_headers`/`_redirects` file exists anywhere in the repo, so the `headers`
  prop overrides nothing today.
- `git diff --check` is clean; `pnpm typecheck` and a fresh uncached infra
  `tsc --noEmit` both pass.

## What I could not verify without a deploy

- **Smart Placement actually kicking in.** It needs "consistent traffic from
  multiple locations" and can take up to 15 minutes to analyze; a low-traffic or
  single-region deployment can report `INSUFFICIENT_INVOCATIONS`, and in rare
  cases `UNSUPPORTED_APPLICATION` (it reverts if it makes things slower). The
  API Worker is reached only through the `TaliWeb` service binding, so whether
  it accumulates enough location diversity for the analysis to conclude is
  observable only in production. The `cf-placement` header (added to requests
  when placement is enabled) is the post-deploy way to confirm (`remote-XXX`
  vs `local-XXX`).
- **Cron-triggered `scheduled()` placement.** Cloudflare documents placement as
  affecting "fetch event handlers" only, so the nightly purge/backup crons may
  run unplaced. This is not a regression — they are not latency-sensitive — but
  it means the D1-colocation win is scoped to the user-facing HTTP path.
- **Whether the `/assets/*` header attaches to the SPA fallback** for a request
  to a non-existent hashed path (the §6 edge case). Immutable-caching the
  fallback HTML at a stale asset path would be a bounded, already-broken-state
  artifact; I could not confirm the exact asset-layer behavior locally.
- **Actual latency improvement magnitude.** The plan's thesis (one cross-region
  hop to the placed API isolate instead of ~11 cross-region D1 round trips) is
  sound, but the measured win depends on the user↔D1 distance and is only
  confirmable with the synthesis' measurement harness after deploy.
