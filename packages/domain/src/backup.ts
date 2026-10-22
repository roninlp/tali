import { Schema } from "effect"

/**
 * Nightly D1 backup metadata (ticket #85).
 *
 * The backup itself is a self-contained SQLite dump written by the Worker into
 * an R2 bucket. This module owns the parts that must be identical wherever the
 * manifest is read or the retention window is enforced:
 *
 * - the object layout (`backups/<UTC date>/…`),
 * - the manifest schema (so a truncated upload is detectable),
 * - the retention planner (so the nightly job and its tests cannot disagree).
 *
 * The provider's own D1 export endpoint is deliberately **not** used: D1
 * cannot export a database that contains virtual tables, and `notes_fts` is an
 * FTS5 virtual table (#41). The decision and its rationale live in
 * `docs/adr/0009-nightly-backup-and-trash-purge.md`.
 */

/** How many daily backups are kept before the nightly job removes the oldest. */
export const BACKUP_RETENTION_DAYS = 14

/** Everything a backup owns lives below this prefix. */
export const BACKUP_PREFIX = "backups/"

/** The file body is a plain SQL script (schema + data), importable by D1. */
export const BACKUP_FORMAT = "sqlite-sql"

export const BACKUP_MANIFEST_VERSION = 1

const DAY_MS = 24 * 60 * 60 * 1000

const SHA256_HEX = /^[0-9a-f]{64}$/

export const BackupTableStat = Schema.Struct({
  name: Schema.String,
  rows: Schema.Int
})
export type BackupTableStat = Schema.Schema.Type<typeof BackupTableStat>

/**
 * One completed backup. The manifest is uploaded **after** the SQL object, so
 * its presence is the commit marker: a crash between the two leaves a dump
 * with no manifest, which retention treats as incomplete and removes.
 */
export const BackupManifest = Schema.Struct({
  version: Schema.Literal(BACKUP_MANIFEST_VERSION),
  /** UTC date (`YYYY-MM-DD`); one backup per night, re-runs overwrite the day. */
  id: Schema.String,
  /** The scheduled instant, not the wall clock at upload time. */
  createdAt: Schema.String,
  database: Schema.String,
  format: Schema.Literal(BACKUP_FORMAT),
  objectKey: Schema.String,
  manifestKey: Schema.String,
  bytes: Schema.Int,
  sha256: Schema.String.check(Schema.isPattern(SHA256_HEX)),
  tables: Schema.Array(BackupTableStat),
  retentionDays: Schema.Int,
  /** The instant after which retention may remove this backup. */
  expiresAt: Schema.String
})
export type BackupManifest = Schema.Schema.Type<typeof BackupManifest>

export interface BackupManifestSource {
  readonly createdAt: string
  readonly database: string
  readonly bytes: number
  readonly sha256: string
  readonly tables: ReadonlyArray<BackupTableStat>
  readonly retentionDays?: number
}

/** The UTC date part of an instant, used as the backup's stable id. */
export const backupDateOf = (instant: string): string => {
  const parsed = Date.parse(instant)
  if (!Number.isFinite(parsed)) {
    throw new Error(`backup: not an ISO-8601 instant: ${instant}`)
  }
  return new Date(parsed).toISOString().slice(0, 10)
}

export const backupObjectKey = (id: string, database = "tali"): string =>
  `${BACKUP_PREFIX}${id}/${database}.sql`

export const backupManifestKey = (id: string): string =>
  `${BACKUP_PREFIX}${id}/manifest.json`

/** Build the manifest for one upload. Keys and expiry are derived, never passed in. */
export const makeBackupManifest = (source: BackupManifestSource): BackupManifest => {
  const id = backupDateOf(source.createdAt)
  const retentionDays = source.retentionDays ?? BACKUP_RETENTION_DAYS
  const createdAt = new Date(Date.parse(source.createdAt)).toISOString()
  return {
    version: BACKUP_MANIFEST_VERSION,
    id,
    createdAt,
    database: source.database,
    format: BACKUP_FORMAT,
    objectKey: backupObjectKey(id, source.database),
    manifestKey: backupManifestKey(id),
    bytes: source.bytes,
    sha256: source.sha256,
    tables: [...source.tables],
    retentionDays,
    expiresAt: new Date(Date.parse(createdAt) + retentionDays * DAY_MS).toISOString()
  }
}

/** Decode a manifest read back from R2; `undefined` for malformed JSON/shape. */
export const parseBackupManifest = (json: string): BackupManifest | undefined => {
  try {
    const decoded = Schema.decodeUnknownOption(BackupManifest)(JSON.parse(json))
    return decoded._tag === "Some" ? decoded.value : undefined
  } catch {
    return undefined
  }
}

/** The UTC date encoded in a backup object key, or `undefined` for anything else. */
export const backupDateOfKey = (key: string): string | undefined => {
  const match = /^backups\/(\d{4}-\d{2}-\d{2})\//.exec(key)
  return match?.[1]
}

export interface BackupRetentionInput {
  /** Every object key currently under {@link BACKUP_PREFIX}. */
  readonly keys: ReadonlyArray<string>
  readonly now: string
  readonly retentionDays?: number
}

/**
 * Which keys the nightly job may delete.
 *
 * A backup is retained for `retentionDays` **days from its date**, not "the
 * newest N files": a missed night must not silently shrink the window, and a
 * re-run on the same date overwrites its own objects rather than counting as a
 * second backup. The newest backup is never deleted even if the clock jumped
 * far ahead — losing the last known-good dump is the one failure a retention
 * policy must not introduce. Keys outside the backup layout are ignored.
 */
export const planBackupRetention = (input: BackupRetentionInput): ReadonlyArray<string> => {
  const retentionDays = input.retentionDays ?? BACKUP_RETENTION_DAYS
  const dated = input.keys
    .map((key) => ({ key, date: backupDateOfKey(key) }))
    .filter((entry): entry is { readonly key: string; readonly date: string } =>
      entry.date !== undefined
    )
  if (dated.length === 0) return []

  const newest = dated.reduce((latest, entry) => (entry.date > latest ? entry.date : latest), "")
  const cutoff = new Date(
    Date.parse(input.now) - retentionDays * DAY_MS
  ).toISOString().slice(0, 10)

  return dated
    .filter((entry) => entry.date !== newest && entry.date < cutoff)
    .map((entry) => entry.key)
}
