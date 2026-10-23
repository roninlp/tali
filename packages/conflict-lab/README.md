# @tali/conflict-lab

A **private, throwaway** test package (ticket #83). Nothing in production
depends on it; it exists to prove that two devices converge.

Each test runs the **real client engine** — `apps/web`'s `LocalStore` +
`createSyncEngine` — with each device on its own `fake-indexeddb` database,
next to the **real api Worker** in workerd (`@cloudflare/vitest-plugin`, the
same harness as the `apps/api/test/boundary` suite). The only substitution is
the network hop: `test/harness.ts`'s instrumented transport reproduces
`httpSyncTransport`'s wire surface (`/sync/pull`, `/sync/bootstrap`,
`/sync/push`, plus the two habit RPC repairs) while recording cursors and push
results. Pushes, pulls, CAS, dedupe, visibility filtering and tombstones are
the production code on both sides of the wire.

## Suites

| File | What it proves |
| --- | --- |
| `test/regression.test.ts` | The deterministic table of races this codebase has actually hit: lost CAS, reused mutation id, private-row replay and pull visibility, a shared→private visibility flip, done-wins under a lost field-LWW edit, delete-wins over an already-landed edit, field LWW, the mirror's "never clobber a pending local edit" rule, and offline habit revive-in-place. |
| `test/simulator.test.ts` | `fast-check` interleavings of two devices (creates, field edits, deletes, revive attempts, sequential and concurrent syncs, duplicate pushes) with shrinking. Asserts field-by-field mirror/server equality **including tombstones**, ack coverage, exactly-once replay, monotonic versions, a cursor that reaches the server high-water, and two semantic oracles (disjoint-field survival and LWW by `clientUpdatedAt`). |
| `test/harness.test.ts` | The harness's own invariants: the nightly flag reaches workerd, the token alphabet still generates every write kind, the ack assertion rejects re-execution, and overlapping RPC calls restore the global `fetch`. |
| `test/smoke.test.ts` | The environment itself: the client engine and fake-indexeddb inside workerd. |

## Run

```sh
pnpm --filter @tali/conflict-lab test          # bounded run: 20 programs × 40 steps (PR CI)
pnpm --filter @tali/conflict-lab test:nightly  # longer run: 100 programs × 70 steps
```

The nightly run is scheduled by `.github/workflows/nightly.yml`. The flag is
resolved in `vitest.config.ts` and injected into workerd (which cannot read the
host `process.env`); `test/harness.test.ts` fails if the injection stops
tracking the CLI flag.
