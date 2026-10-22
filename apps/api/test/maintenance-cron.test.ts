import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { TRASH_RETENTION_MS } from "@tali/domain"
import worker, { BACKUP_CRON, PURGE_CRON } from "../src/index.js"
import { FakeD1 } from "./fake-d1.js"
import { FakeR2 } from "./fake-r2.js"

/**
 * The real `scheduled()` dispatch (ticket #85).
 *
 * The purge and backup runners are tested directly elsewhere; this suite pins
 * the wiring that production actually uses: `controller.cron` selects the
 * job, `scheduledTime` is the nominal clock, both jobs run through
 * `ctx.waitUntil`, and the D1 + R2 bindings are the same ones the fetch handler
 * gets. It is the closest local equivalent of workerd's
 * `/cdn-cgi/local/scheduled` route.
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

const seedOldNote = (db: DatabaseSync, id: string) => {
  const now = "2026-10-23T03:17:00.000Z"
  const deletedAt = new Date(
    Date.parse(now) - TRASH_RETENTION_MS - 24 * 60 * 60 * 1000
  ).toISOString()
  db.prepare(
    `INSERT INTO notes
      (id, title, body, plain_text, owner_id, household_id, visibility,
       is_pinned, is_archived, tag_ids, created_at, updated_at, version, deleted_at)
     VALUES (?, 'دارو', NULL, 'دارو', 'user-a', 'household-a', 'shared',
       0, 0, '[]', ?, ?, 1, ?)`
  ).run(id, now, now, deletedAt)
  db.prepare(
    `INSERT INTO notes_fts (note_id, search_title, search_body) VALUES (?, 'دارو', 'دارو')`
  ).run(id)
  db.prepare(
    `INSERT INTO change_feed
      (household_id, entity_type, entity_id, op, version, updated_at, owner_id, visibility)
     VALUES ('household-a', 'note', ?, 'delete', 1, ?, 'user-a', 'shared')`
  ).run(id, now)
}

const scheduledEnv = (db: FakeD1, r2: FakeR2) => ({
  DB: db.asD1Database(),
  BACKUP_BUCKET: r2.asR2Bucket(),
  BACKUP_DATABASE_NAME: "tali",
  BACKUP_RETENTION_DAYS: "14"
})

const runScheduled = async (
  cron: string,
  at: string,
  env: ReturnType<typeof scheduledEnv>
): Promise<void> => {
  const pending: Array<Promise<unknown>> = []
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => {}
  } as unknown as ExecutionContext
  const controller = {
    cron,
    scheduledTime: Date.parse(at),
    noRetry: () => {}
  } as unknown as ScheduledController

  await worker.scheduled(controller, env as never, ctx)
  await Promise.all(pending)
}

const count = (db: DatabaseSync, sql: string, ...params: ReadonlyArray<string>): number =>
  (db.prepare(sql).get(...(params as Array<string>)) as { readonly n: number }).n

describe("nightly maintenance cron", () => {
  it("routes the purge expression to the trash purge", async () => {
    const db = makeDatabase()
    seedOldNote(db, "old-note")
    const fake = new FakeD1(db)
    const r2 = new FakeR2()

    await runScheduled(PURGE_CRON, "2026-10-23T03:17:00.000Z", scheduledEnv(fake, r2))

    expect(count(db, "SELECT COUNT(*) AS n FROM notes WHERE id = 'old-note'")).toBe(0)
    expect(count(db, "SELECT COUNT(*) AS n FROM notes_fts WHERE note_id = 'old-note'")).toBe(0)
    expect(
      count(db, "SELECT COUNT(*) AS n FROM change_feed WHERE entity_id = 'old-note'")
    ).toBe(0)
    // The purge night does not also write a backup.
    expect(r2.objects.size).toBe(0)
  })

  it("routes the backup expression to the nightly dump", async () => {
    const db = makeDatabase()
    seedOldNote(db, "old-note")
    const fake = new FakeD1(db)
    const r2 = new FakeR2()

    await runScheduled(BACKUP_CRON, "2026-10-23T03:47:00.000Z", scheduledEnv(fake, r2))

    expect(r2.objects.has("backups/2026-10-23/tali.sql")).toBe(true)
    expect(r2.objects.has("backups/2026-10-23/manifest.json")).toBe(true)
    // The backup night does not also purge.
    expect(count(db, "SELECT COUNT(*) AS n FROM notes WHERE id = 'old-note'")).toBe(1)
  })
})
