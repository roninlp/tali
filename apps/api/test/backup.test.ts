import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import {
  BACKUP_PREFIX,
  backupDateOfKey,
  backupManifestKey,
  backupObjectKey,
  makeBackupManifest,
  parseBackupManifest,
  planBackupRetention
} from "@tali/domain"
import { runD1Backup } from "../src/d1-backup.js"
import { FakeD1 } from "./fake-d1.js"
import { FakeR2 } from "./fake-r2.js"

/**
 * Ticket #85's backup manifest and retention logic, plus the nightly runner
 * over a real SQLite database and an in-memory R2 bucket.
 *
 * These tests answer the acceptance question directly: does a backup land for
 * N consecutive nights, does it carry a verifiable manifest, and does the
 * window remove the right whole backups while keeping the newest one?
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)

const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort()

const makeDatabase = (): DatabaseSync => {
  const db = new DatabaseSync(":memory:")
  for (const file of migrationFiles()) {
    db.exec(readFileSync(fileURLToPath(new URL(file, MIGRATIONS_DIR)), "utf8"))
  }
  return db
}

const seed = (db: DatabaseSync, id: string) => {
  const now = "2026-10-20T00:00:00.000Z"
  db.prepare(
    `INSERT INTO notes
      (id, title, body, plain_text, owner_id, household_id, visibility,
       is_pinned, is_archived, tag_ids, created_at, updated_at, version, deleted_at)
     VALUES (?, 'دارو', NULL, 'دارو', 'user-a', 'household-a', 'shared',
       0, 0, '[]', ?, ?, 1, NULL)`
  ).run(id, now, now)
  db.prepare(
    `INSERT INTO notes_fts (note_id, search_title, search_body) VALUES (?, 'دارو', 'دارو')`
  ).run(id)
  db.prepare(
    `INSERT INTO change_feed
      (household_id, entity_type, entity_id, op, version, updated_at, owner_id, visibility)
     VALUES ('household-a', 'note', ?, 'upsert', 1, ?, 'user-a', 'shared')`
  ).run(id, now)
}

const night = (date: string): string => `${date}T03:47:00.000Z`

describe("backup manifest", () => {
  it("derives stable keys and a retention expiry", () => {
    const manifest = makeBackupManifest({
      createdAt: "2026-10-23T03:47:00.000Z",
      database: "tali",
      bytes: 1234,
      sha256: "a".repeat(64),
      tables: [{ name: "notes", rows: 3 }],
      retentionDays: 14
    })

    expect(manifest.id).toBe("2026-10-23")
    expect(manifest.objectKey).toBe("backups/2026-10-23/tali.sql")
    expect(manifest.manifestKey).toBe("backups/2026-10-23/manifest.json")
    expect(manifest.expiresAt).toBe("2026-11-06T03:47:00.000Z")
    expect(parseBackupManifest(JSON.stringify(manifest))).toEqual(manifest)
  })

  it("rejects malformed JSON and a bad hash", () => {
    expect(parseBackupManifest("not-json")).toBeUndefined()
    expect(
      parseBackupManifest(JSON.stringify({ version: 1, sha256: "nope" }))
    ).toBeUndefined()
  })

  it("derives the backup date from an object key", () => {
    expect(backupDateOfKey("backups/2026-10-23/tali.sql")).toBe("2026-10-23")
    expect(backupDateOfKey("backups/2026-10-23/manifest.json")).toBe("2026-10-23")
    expect(backupDateOfKey("other/2026-10-23/tali.sql")).toBeUndefined()
    expect(backupDateOfKey(`${BACKUP_PREFIX}not-a-date/tali.sql`)).toBeUndefined()
  })
})

describe("backup retention", () => {
  const keysFor = (dates: ReadonlyArray<string>) =>
    dates.flatMap((date) => [
      backupObjectKey(date, "tali"),
      backupManifestKey(date)
    ])

  it("removes backups older than the window and keeps the newest", () => {
    const keys = keysFor(["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"])
    const expired = planBackupRetention({
      keys,
      now: "2026-10-23T03:47:00.000Z",
      retentionDays: 3
    })

    expect(expired).toEqual(keysFor(["2026-10-18", "2026-10-19"]))
  })

  it("never removes the newest backup even when the clock jumps past the window", () => {
    const keys = keysFor(["2026-01-01", "2026-01-02"])
    const expired = planBackupRetention({
      keys,
      now: "2026-10-23T03:47:00.000Z",
      retentionDays: 3
    })
    expect(expired).toEqual(keysFor(["2026-01-01"]))
  })

  it("ignores keys outside the backup layout", () => {
    expect(
      planBackupRetention({
        keys: ["notes.txt", "backups/not-a-date/x.sql"],
        now: "2026-10-23T03:47:00.000Z",
        retentionDays: 3
      })
    ).toEqual([])
    expect(
      planBackupRetention({ keys: [], now: "2026-10-23T03:47:00.000Z" })
    ).toEqual([])
  })
})

describe("nightly backup runner", () => {
  it("lands one dump + manifest per night and prunes the window", async () => {
    const db = makeDatabase()
    seed(db, "note-1")
    const fakeDb = new FakeD1(db)
    const r2 = new FakeR2()
    const env = {
      DB: fakeDb.asD1Database(),
      BACKUP_BUCKET: r2.asR2Bucket(),
      BACKUP_DATABASE_NAME: "tali",
      BACKUP_RETENTION_DAYS: "3"
    }

    const nights = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"]
    for (const date of nights) {
      await runD1Backup(env, night(date))
    }

    // 20th fell out of the window when the 24th landed; the newest is kept.
    expect([...r2.objects.keys()].some((key) => key.includes("2026-10-20"))).toBe(false)
    for (const date of nights.slice(1)) {
      const objectKey = `backups/${date}/tali.sql`
      const manifestKey = `backups/${date}/manifest.json`
      expect(r2.objects.has(objectKey)).toBe(true)
      expect(r2.objects.has(manifestKey)).toBe(true)

      const manifest = parseBackupManifest(
        new TextDecoder().decode(r2.objects.get(manifestKey)!.bytes)
      )
      expect(manifest).toBeDefined()
      expect(manifest?.id).toBe(date)
      expect(manifest?.objectKey).toBe(objectKey)
      expect(manifest?.tables.find((table) => table.name === "notes")?.rows).toBe(1)
      expect(manifest?.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(manifest?.bytes).toBe(r2.objects.get(objectKey)!.bytes.byteLength)
    }

    const dump = new TextDecoder().decode(
      r2.objects.get("backups/2026-10-24/tali.sql")!.bytes
    )
    expect(dump).toContain("CREATE VIRTUAL TABLE")
    expect(dump).toContain("INSERT INTO \"notes_fts\"")
    expect(dump).toContain("INSERT INTO \"notes\"")
  })

  it("fails loudly when the R2 binding is missing", async () => {
    const db = makeDatabase()
    await expect(
      runD1Backup({ DB: new FakeD1(db).asD1Database() }, night("2026-10-23"))
    ).rejects.toThrow(/BACKUP_BUCKET/)
  })
})
