import { Effect, Layer } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  BACKUP_PREFIX,
  BACKUP_RETENTION_DAYS,
  makeBackupManifest,
  planBackupRetention
} from "@tali/domain"
import { dumpDatabase } from "./d1-dump.js"

/**
 * The nightly D1 backup (ticket #85).
 *
 * Design decision: the dump is built **by the Worker from its own D1 binding**
 * and written to **R2**, rather than calling the provider's D1 export API.
 * D1's export endpoint refuses a database containing virtual tables, and
 * `notes_fts` is FTS5 (#41); it would also need an account-scoped API token
 * stored as a secret. The binding path needs no extra credential, keeps the
 * backup inside the same trust boundary as the data, and can include the FTS
 * rows. See `docs/adr/0009-nightly-backup-and-trash-purge.md`.
 *
 * Object layout (one backup per UTC night; a re-run overwrites its own day):
 *
 *   backups/<YYYY-MM-DD>/<database>.sql   the dump
 *   backups/<YYYY-MM-DD>/manifest.json    size, sha256, table row counts, expiry
 *
 * The manifest is written **after** the dump, so its presence is the commit
 * marker. Retention removes whole dated prefixes older than the window, and
 * never removes the newest backup even if the clock moved unexpectedly.
 */

export interface BackupEnv {
  readonly DB: D1Database
  /** R2 binding declared in `infra/alchemy.run.ts`. */
  readonly BACKUP_BUCKET?: R2Bucket
  /** Logical database name recorded in the manifest (default `tali`). */
  readonly BACKUP_DATABASE_NAME?: string
  /** Retention window, as a string binding; defaults to {@link BACKUP_RETENTION_DAYS}. */
  readonly BACKUP_RETENTION_DAYS?: string
}

export interface BackupResult {
  readonly at: string
  readonly objectKey: string
  readonly manifestKey: string
  readonly bytes: number
  readonly sha256: string
  readonly tables: number
  readonly retentionDays: number
  readonly deleted: number
}

export const backupRetentionDays = (env: BackupEnv): number => {
  const parsed = Number(env.BACKUP_RETENTION_DAYS ?? BACKUP_RETENTION_DAYS)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : BACKUP_RETENTION_DAYS
}

/** No query/result renaming: the dump must preserve physical column names. */
export const dumpLayer = (db: D1Database) => D1Client.layer({ db })

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

const listAllKeys = async (bucket: R2Bucket, prefix: string): Promise<ReadonlyArray<string>> => {
  const keys: Array<string> = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 })
    for (const object of page.objects) keys.push(object.key)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor !== undefined)
  return keys
}

/**
 * One backup at `now` (the cron tick's nominal instant).
 *
 * Everything except the D1/R2 bindings is pure and testable: the dump builder,
 * the manifest builder and the retention planner. The test suite runs this
 * twice over an in-memory bucket to prove a backup lands and ages out.
 */
export const runD1Backup = async (env: BackupEnv, now: string): Promise<BackupResult> => {
  const bucket = env.BACKUP_BUCKET
  if (bucket === undefined) {
    throw new Error(
      "BACKUP_BUCKET is not bound: declare the R2 bucket in infra/alchemy.run.ts"
    )
  }

  const dump = await Effect.runPromise(
    Effect.provide(dumpDatabase, dumpLayer(env.DB))
  )
  const bytes = new TextEncoder().encode(dump.sql)
  const database = env.BACKUP_DATABASE_NAME?.trim() || "tali"
  const retentionDays = backupRetentionDays(env)
  const manifest = makeBackupManifest({
    createdAt: now,
    database,
    bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    tables: dump.tables,
    retentionDays
  })

  await bucket.put(manifest.objectKey, bytes, {
    httpMetadata: { contentType: "application/sql" }
  })
  // Commit marker: written last, and only after the dump body is durable.
  await bucket.put(manifest.manifestKey, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json" }
  })

  const keys = await listAllKeys(bucket, BACKUP_PREFIX)
  const expired = planBackupRetention({ keys, now, retentionDays })
  if (expired.length > 0) await bucket.delete([...expired])

  return {
    at: now,
    objectKey: manifest.objectKey,
    manifestKey: manifest.manifestKey,
    bytes: manifest.bytes,
    sha256: manifest.sha256,
    tables: manifest.tables.length,
    retentionDays,
    deleted: expired.length
  }
}
