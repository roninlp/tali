# Trash purge and backup restore runbook

Ticket: [#85](https://github.com/roninlp/tali/issues/85) · Decision record:
[ADR-0009](adr/0009-nightly-backup-and-trash-purge.md)

## What runs automatically

| UTC cron | Job | Entry point |
| --- | --- | --- |
| `* * * * *` | Reminder sweep (pre-existing, ADR-0005) | `scheduled()` → `runReminderSweep` |
| `17 3 * * *` | Trash purge | `scheduled()` → `runTrashPurge` |
| `47 3 * * *` | D1 backup to R2 | `scheduled()` → `runD1Backup` |

All three are declared in `infra/alchemy.run.ts`. `alchemy dev` does **not**
run cron triggers, so local verification uses the workerd scheduled route (see
below) or the test suite.

The purge hard-deletes rows whose `deletedAt` is older than
`TRASH_RETENTION_DAYS` (30) across every sync-registered aggregate, together
with their `change_feed` rows and derived state (`notes_fts`, `item_tags`) in
one D1 batch per chunk. It is bounded to 40 rows per aggregate per night, so a
large backlog can take more than one night. Each run logs one JSON line:

```json
{"event":"trash.purge","at":"2026-10-23T03:17:00.000Z","cutoff":"2026-09-23T03:17:00.000Z","purged":3,"entities":[{"entityType":"note","selected":3,"purged":3}],"statements":14,"capped":false}
```

The backup writes:

```text
backups/<UTC date>/<database>.sql   the importable dump (schema + rows + FTS)
backups/<UTC date>/manifest.json    size, SHA-256, table row counts, expiry
```

and keeps 14 days by default (`BACKUP_RETENTION_DAYS`). The manifest is written
last: **a dump with no manifest is an incomplete backup**.

## Verify locally (no Cloudflare credentials)

The automated drill is the authoritative check:

```sh
pnpm --filter @tali/api exec vitest run \
  test/trash-purge.test.ts \
  test/backup.test.ts \
  test/restore-drill.test.ts
```

It covers:

- old tombstones gone from rows + feed + FTS while recent/live rows survive,
  and old tag/item joins removed;
- idempotent re-runs and the per-tick statement ceiling;
- a row restored between the selection read and the batch survives;
- one backup + manifest per night for N nights, manifest verification and the
  retention window (including “never delete the newest”);
- a full rebuild: migrations → dump → fresh database → sync bootstrap + push +
  pull + FTS search.

To drive the **real Worker** path locally (not just the functions), boot the
stack and invoke the scheduled handler with the real cron expression:

```sh
pnpm dev          # api on :8787 with local D1 + local R2

# Purge (03:17 UTC)
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=17+3+*+*+*&time=1792725420000"

# Backup (03:47 UTC)
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=47+3+*+*+*&time=1792727220000"

# The per-minute reminder sweep still works
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"
```

The local R2 objects live under the Alchemy local state and can be inspected
with the Local Explorer or by looking for the `backups/` prefix in the local R2
gateway storage. The response is `{"outcome":"ok"}` when the handler was invoked;
the job's own result is in the dev-server log line (`trash.purge` /
`d1.backup`).

## Restore from a nightly backup

The dump is a normal SQLite SQL script. Restore it into an **empty** database:
it contains the schema and data, so importing on top of an already-migrated
database will hit “table already exists”. Keeping the restore target separate
also makes the drill safe.

### 1. Find the bucket and the latest backup

The bucket name is Alchemy's physical name (check `pnpm stack:plan` / the
deployed stack output, or list buckets in the dashboard). Then:

```sh
BUCKET=<bucket-name-from-stack>

pnpm dlx wrangler r2 object list "$BUCKET" --prefix=backups/
pnpm dlx wrangler r2 object get "$BUCKET/backups/2026-10-24/manifest.json" \
  --file=/tmp/tali-backup-manifest.json
pnpm dlx wrangler r2 object get "$BUCKET/backups/2026-10-24/tali.sql" \
  --file=/tmp/tali-backup.sql
```

### 2. Verify the artefact before importing it

```sh
sha256sum /tmp/tali-backup.sql
# compare with .sha256 in /tmp/tali-backup-manifest.json
```

If the hash does not match, try the previous night. Do not restore a dump whose
manifest is missing or whose hash differs.

### 3. Import into a scratch D1 database

```sh
pnpm dlx wrangler d1 create tali-restore-drill
pnpm dlx wrangler d1 execute tali-restore-drill --remote \
  --file=/tmp/tali-backup.sql
```

The script starts with `PRAGMA defer_foreign_keys = true;` and orders tables
parents-first; that is what makes a database with foreign keys importable even
though D1 executes the file statement by statement.

### 4. Prove the restored database before pointing the app at it

```sh
pnpm dlx wrangler d1 execute tali-restore-drill --remote --command "
  SELECT
    (SELECT COUNT(*) FROM notes) AS notes,
    (SELECT COUNT(*) FROM notes_fts) AS fts_rows,
    (SELECT COUNT(*) FROM change_feed) AS feed,
    (SELECT COUNT(*) FROM __alchemy_migrations) AS migrations;
"

# Persian search must work against the restored FTS index:
pnpm dlx wrangler d1 execute tali-restore-drill --remote --command "
  SELECT note_id FROM notes_fts WHERE notes_fts MATCH 'دارو' LIMIT 5;
"
```

The row counts should match the manifest's `tables` array. `notes_fts` is
included in the dump (folded text preserved); it is not rebuilt from `notes`.

### 5. Cut over (only after the checks pass)

Create a separate Worker environment/stage bound to the restored database, or
rename/re-point the D1 binding in `infra/alchemy.run.ts` and redeploy. Never
import over the live database: the script is not an incremental migration.

## Deploy-only step (not exercised in this repo)

The deploy path has never been exercised here (#44: no Cloudflare credentials),
so one manual verification is required before treating the backup as
operational:

1. With an Alchemy profile/`CLOUDFLARE_API_TOKEN` available:
   ```sh
   pnpm stack:plan     # expect TaliDatabase, TaliBackups, TaliApi with 3 crons
   pnpm stack:deploy
   ```
2. Confirm in the dashboard (Worker → Settings → Triggers) that all three cron
   expressions exist, and that the Worker has an `r2_bucket` binding for
   `TaliBackups` (no public access).
3. Wait for one 03:17/03:47 UTC cycle (or temporarily use a near-future cron in
   a staging stage). Check Workers Logs for `trash.purge` and `d1.backup` with
   `"capped":false` and no `*.failed` line.
4. List R2 and confirm the dated `.sql` + `manifest.json` pair, then perform the
   restore steps above against a throwaway D1 database.
5. Record the deployed run (stage, date, manifest hash) on the ticket. That is
   the restore drill's deployed half; the local half is the automated test.

## Known limitations

- The provider's D1 export endpoint cannot export this database because
  `notes_fts` is an FTS5 virtual table; that is why the Worker writes the dump.
- One `SELECT *` per table means the dump is loaded into Worker memory. The
  product is a two-user household; if a table ever grows beyond Worker memory,
  the dump needs per-table paging (and a larger CPU budget).
- `wrangler d1 execute --file` is subject to D1's statement-size limit. The dump
  splits `INSERT`s at 60 KB / 100 rows, well below it; a single note body above
  that limit still becomes its own statement and is safe.
- Retention deletes by UTC date. A backup re-run later on the same date
  overwrites that date's pair instead of creating a second nightly copy.
