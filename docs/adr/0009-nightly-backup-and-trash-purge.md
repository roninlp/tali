# ADR-0009: Trash purge on a nightly cron, and backups as Worker-written SQL dumps in R2

- **Status:** Accepted (2026-10-23)
- **Deciders:** Tali developer (wayfinder #85); the backup target was delegated to the implementing session by the ticket
- **Related:** tickets #85 (purge + backup), #7/#8 (soft delete and feed retention), #34 (sync registry), #41 (FTS5 note search), #44 (`alchemy dev`), #61 (per-minute cron pattern), ADR-0005 (cron dispatch)

## Context

Slice 5 closes two data-lifecycle gaps:

1. **Trash** is a soft delete with a 30-day restore window (settled in #7).
   Nothing hard-deleted those rows, so tombstones, their `change_feed` entries
   and their `notes_fts` rows accumulated forever.
2. **Backups.** A household's planner data is the product. Time Travel gives
   D1 a 30-day point-in-time window, but not a portable artefact the owner can
   restore without Cloudflare's UI, and not a copy under a separate retention
   policy.

The backup target had two plausible shapes:

- **The provider's D1 export endpoint.** `POST /accounts/:id/d1/database/:id/export`
  returns a signed URL to an SQL dump. It is account-scoped and needs an API
  token; more importantly, Cloudflare documents that **export is not supported
  for virtual tables**, and Tali's `notes_fts` is an FTS5 virtual table (#41).
  It would fail on the production schema.
- **A Worker-written dump to R2.** The Worker already has the D1 binding, so it
  can read `sqlite_schema` and each table, include the FTS rows, and write the
  script to an R2 bucket through an `r2_bucket` binding. No account API token,
  no second data path, and the FTS index is part of the backup.

## Decision

### Trash purge

- **One nightly cron trigger on the existing Worker** (`17 3 * * *`), handled by
  the module's `scheduled()` next to the per-minute reminder sweep. The cron
  expressions live in `@tali/config` and are imported by both
  `infra/alchemy.run.ts` and the Worker, so a schedule change cannot silently
  dispatch to the wrong job.
- **30 days, one constant.** `TRASH_RETENTION_DAYS`/`TRASH_RETENTION_MS` live in
  `packages/domain/src/common.ts`; the note service's restore refusal uses the
  same value.
- **Every sync-registered aggregate.** The sweep iterates the #34 registry, so
  adding an aggregate to sync automatically adds it to the purge. Aggregate
  specific cleanup (FTS rows, tag joins, reference repairs) lives in a
  registry-level `purge` hook next to the aggregate; parent/child ordering and
  child-feed cleanup come from the registry's existing `parent` metadata.
- **One batch per id chunk, together:** delete child rows and their feed
  entries, run the aggregate's `purge` hook, delete the row, and delete every
  `change_feed` entry for it — all in the same `D1Client.batch()`. A crash
  cannot leave the feed or search index describing a row that no longer exists.
  The feed delete keeps the newest row (mirroring the 90-day prune guard) so
  `minSeq` never becomes empty; the pull path additionally treats a non-zero
  cursor against an empty feed as stale.
- **Bounded.** At most 40 rows per aggregate and at most 48 statements per
  tick (D1 Free allows 50 queries per invocation); a backlog drains over
  successive nights. Chunks are 40 ids, far under D1's 100-parameter limit.
- **Idempotent and restore-safe.** The delete repeats `deleted_at < cutoff`,
  and every feed/index cleanup is gated on the row not being live, so a row
  restored between the selection read and the batch survives with its feed and
  search text.
- **Logged** as one JSON line (`trash.purge`) with per-aggregate counts, the
  cutoff, statements used and whether a backlog remains.

### Nightly backup

- **A separate nightly cron trigger** (`47 3 * * *`), after the purge, so the
  dump captures the pruned database and each job has its own D1 per-invocation
  query budget.
- **A Worker-written SQL script to R2.** `d1-dump.ts` reads `sqlite_schema`
  (including the FTS5 virtual table, excluding its shadow tables) and one
  `SELECT *` per table, then renders an importable script with chunked
  multi-row `INSERT`s. `d1-backup.ts` writes
  `backups/<UTC date>/<database>.sql` and, **after it**,
  `backups/<UTC date>/manifest.json`.
- **The manifest is the commit marker.** It records the size, SHA-256, per-table
  row counts and expiry; an upload interrupted between the two objects leaves a
  dump with no manifest.
- **Retention is 14 calendar days by default** (`BACKUP_RETENTION_DAYS`,
  including today), enforced by `planBackupRetention` over whole dated
  prefixes. The newest complete backup is never removed even if the clock
  jumps; a dated prefix missing its `.sql` or manifest is an interrupted upload
  and is removed. The bucket also declares a 30-day lifecycle delete rule as a
  deliberately longer safety net if the Worker misses nights. Deletion is
  chunked to R2's 1000-key limit.
- **No new secret.** The bucket is private and reachable only through the
  Worker's R2 binding. `BACKUP_BUCKET`, `BACKUP_DATABASE_NAME` and
  `BACKUP_RETENTION_DAYS` are declared in Alchemy alongside D1.
- **Restore is drilled, not assumed.** `apps/api/test/restore-drill.test.ts`
  builds a database from the real migrations, dumps it, replays the dump into a
  fresh database, then bootstraps, pushes, pulls and searches through the real
  sync engine. `docs/backup-restore.md` is the operator runbook, including the
  deploy-only steps this repo cannot exercise without Cloudflare credentials.

## Consequences

- A trashed row disappears from rows, feed and search at the same instant. The
  feed guard keeps the newest feed row, and a stale cursor against an otherwise
  empty feed is treated as `resetRequired`, so a client can never keep a
  purged mirror forever. This can force the reset at roughly 30 days, earlier
  than the 90-day feed-retention window.
- Purging a habit explicitly removes its `habit_entries` and their feed rows
  before the parent row; `habitEntry` is one of the 11 synced, client-writable
  aggregates, so leaving its feed behind was a real dangling reference. A
  purged reminder still relies on the dispatch ledger's `ON DELETE CASCADE`
  (the ledger is server-written, not a sync aggregate).
- Deleting a project repairs every live task that referenced it as a real
  mutation: `project_id = NULL`, version + 1, `updated_at` = the tick, and a
  feed row. A purge can therefore never silently null a task in the database
  while leaving every mirror on the old value.
- Deleting a tag removes it from live items' denormalized `tag_ids` with the
  same version/feed contract as any other mutation, so the UI does not keep a
  dead chip.
- The FTS index travels in the dump, so a restored database is immediately
  searchable with the exact folded text it had. Rebuilding it from `notes`
  would have lost the folded spelling.
- A backup is one object per night. Re-running the job on the same UTC date
  overwrites the same keys, which makes the cron idempotent and makes a manual
  drill safe. A single row larger than the dump's 60 KB INSERT budget fails the
  backup loudly rather than producing an unimportable file.
- The provider's D1 export endpoint is intentionally unused; if a future
  migration drops `notes_fts`, the endpoint could be reconsidered, but it would
  still require an account API token that the current design does not need.
- **Known gap:** the deployed path (real R2 bucket, real cron trigger, R2
  download → D1 import) was not exercised in this environment because there are
  no Cloudflare credentials; the repo's deploy path has never been exercised
  (#44). The runbook calls this out as the one manual step before trusting the
  backup operationally.
