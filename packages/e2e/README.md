# Gate flows (E2E)

The five end-to-end flows from the verification strategy
([#81](https://github.com/roninlp/tali/issues/81), [#84](https://github.com/roninlp/tali/issues/84)),
run by Playwright against a real local stack.

```sh
pnpm --filter @tali/e2e install:browsers   # once
pnpm test:e2e                              # from the repo root
```

The runner boots `alchemy dev --stage e2e` itself: a fresh local D1 (migrations
apply on reconcile), the api Worker on `:8787` and the Vite SPA on `:3000`.
Stop any `pnpm dev` first — the ports are pinned, and attaching to the developer
stack would run the flows against real local data. A run deletes the `e2e`
stage's state (`E2E_KEEP_STATE=1` keeps it for debugging); the `dev_<user>`
database is never touched.

The five flows:

| File | Flow |
| --- | --- |
| `01-household.spec.ts` | register → create household → invite → second account joins |
| `02-offline-task.spec.ts` | offline quick-add → reload offline → reconnect → converges on both devices |
| `03-shared-list.spec.ts` | item checked on A appears live on B |
| `04-reminder.spec.ts` | medication reminder fires → Done from the notification → inbox shows it |
| `05-recurring-event.spec.ts` | recurring event in week/month → "this and following" split |

## Seams

Two parts of the product cannot be driven literally on a local dev stack; both
are exercised through the production code path immediately behind the tap.

**Offline reload.** The SPA is served by Vite and `public/sw.js` deliberately
caches no app shell, so `context.setOffline(true)` + `reload()` cannot load the
document at all. Flow 2 cuts only the API origin (`localhost:8787`), reloads,
and lets the app boot from IndexedDB and the cached session. The visible badge
is therefore "ارتباط با سرور برقرار نشد؛ نمایش از حافظهٔ محلی", not the
navigator-offline wording. A real app-shell cache is outside the Must scope.

**Notification Done.** `alchemy dev` cannot deliver Web Push, and Playwright
cannot click an OS notification. Flow 4 writes the record the service worker
writes on a Done tap into the device queue (`tali.push.v1` → `actions`) and
reloads `/reminders`; the real page drain then posts
`POST /reminders/dispatches/:id/respond`. Everything after the click is the
shipped path. Real delivery is covered by unit/service tests (VAPID + aes128gcm)
and the two-user acceptance week.

**Seeding.** There is no UI for creating reminders or recurring events yet, so
flows 4 and 5 seed those rows through `POST /sync/push` — the same offline
transport the app uses — and then drive the real inbox, editor and scope prompt.
Identities are seeded once per run by `seed.setup.ts` over the real auth routes;
flow 1 is the only flow that registers through the UI.

## Failure artefacts

A failure keeps its trace, video, screenshot and the seeded ids under
`test-results/` and `playwright-report/`; CI uploads both. No assertion depends
on wall-clock timing — the suite records nothing in the perf baseline, which is
the sign-off procedure in `docs/verification.md`.
