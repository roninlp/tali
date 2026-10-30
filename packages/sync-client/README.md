# @tali/sync-client

The framework-free client core behind the Foldkit app's local-first sync:

- `local-store/store.ts` — the IndexedDB mirror + outbox, one database per user.
- `local-store/coalescing.ts` — the pure write rules (mirror merge, outbox fold,
  tombstone preservation, sent-entry immutability).
- `local-store/mirror.ts` — live/trashed/failed projections.
- `sync-engine.ts` — pull → push → ack reconciliation, transport-injected.
- `sync-cadence.ts` — the pure poll/backoff delay table.
- `task.ts` — the temporary P2.4 task projection and offline quick-add write.

`apps/web-foldkit/src/sync.ts` wraps this package in a Foldkit Submodel: the
Model holds the snapshots, the store is a `ManagedResource`, the engine runs in
a Command, and the cadence runs in a Subscription. `@tali/conflict-lab` imports
the same store and engine, so its two-device convergence suites exercise the
production client path.
