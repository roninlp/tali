# @tali/conflict-lab

A **private, throwaway** test package (ticket #83). Nothing in production
depends on it; it exists to prove that two devices converge.

Each test runs the **real client engine** — `apps/web`'s `LocalStore` +
`createSyncEngine` — with each device on its own `fake-indexeddb` database,
next to the **real api Worker** in workerd (`@cloudflare/vitest-plugin`, the
same harness as the `apps/api/test/boundary` suite). There is no fake
transport and no fake server: pushes, pulls, CAS, dedupe and tombstones are the
production code on both sides of the wire.

## Suites

| File | What it proves |
| --- | --- |
| `test/regression.test.ts` | The deterministic table of races this codebase has actually hit: lost CAS, reused mutation id, private-row replay, done-wins, delete-wins, field LWW, offline habit revive-in-place. |
| `test/simulator.test.ts` | `fast-check` interleavings of two devices (writes, deletes, revive attempts, sequential and concurrent syncs, duplicate pushes) with shrinking; asserts field-by-field mirror/server equality, ack coverage, monotonic versions/cursors, and two semantic oracles (disjoint-field survival and LWW by `clientUpdatedAt`). |
| `test/smoke.test.ts` | The environment itself: the client engine and fake-indexeddb inside workerd. |

## Run

```sh
pnpm --filter @tali/conflict-lab test          # bounded run (PR CI)
pnpm --filter @tali/conflict-lab test:nightly  # longer randomised run
```

The nightly run is scheduled by `.github/workflows/nightly.yml`.
