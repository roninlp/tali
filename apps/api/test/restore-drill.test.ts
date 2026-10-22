import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  type SyncEntityType,
  type SyncPushEntry,
  uuidV7
} from "@tali/domain"
import { SyncService, SyncServiceLive } from "../src/sync-service.js"
import { dumpDatabase } from "../src/d1-dump.js"
import { FakeD1 } from "./fake-d1.js"

/**
 * The restore drill (ticket #85).
 *
 * It does exactly what the runbook says, but locally and automatically:
 *
 * 1. build a D1-shaped database from the real migrations and seed rows;
 * 2. dump it with the same code the nightly Worker runs;
 * 3. replay the dump into a **fresh empty** database;
 * 4. run the real sync engine against the restored database — bootstrap the
 *    seeded rows, push a new note, pull it back, and search the rebuilt FTS
 *    index.
 *
 * What this cannot prove locally is the Cloudflare deploy path (the real R2
 * bucket and the real cron). That is documented as an explicit runbook step in
 * `docs/backup-restore.md`; the deploy path was never exercised in this repo
 * (#44).
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)

const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort()

const USER = "user-a"
const HOUSEHOLD = "household-a"
const NOW = "2026-10-20T00:00:00.000Z"

const makeSource = (): DatabaseSync => {
  const db = new DatabaseSync(":memory:")
  for (const file of migrationFiles()) {
    db.exec(readFileSync(fileURLToPath(new URL(file, MIGRATIONS_DIR)), "utf8"))
  }

  db.prepare(
    `INSERT INTO tasks
      (id, title, owner_id, household_id, visibility, status, priority,
       time_zone, tag_ids, created_at, updated_at, version, deleted_at)
     VALUES ('task-1', 'خرید نان', ?, ?, 'shared', 'todo', 'medium',
       'Asia/Tehran', '[]', ?, ?, 1, NULL)`
  ).run(USER, HOUSEHOLD, NOW, NOW)

  db.prepare(
    `INSERT INTO notes
      (id, title, body, plain_text, owner_id, household_id, visibility,
       is_pinned, is_archived, tag_ids, created_at, updated_at, version, deleted_at)
     VALUES ('note-1', 'دارو', NULL, 'دارو', ?, ?, 'shared', 1, 0, '[]', ?, ?, 2, NULL)`
  ).run(USER, HOUSEHOLD, NOW, NOW)
  db.prepare(
    `INSERT INTO notes_fts (note_id, search_title, search_body)
     VALUES ('note-1', 'دارو', 'دارو')`
  ).run()

  db.prepare(
    `INSERT INTO lists
      (id, title, owner_id, household_id, visibility, sort, checked_placement,
       created_at, updated_at, version, deleted_at)
     VALUES ('list-1', 'خانه', ?, ?, 'shared', 'manual', 'bottom', ?, ?, 1, NULL)`
  ).run(USER, HOUSEHOLD, NOW, NOW)

  db.prepare(
    `INSERT INTO list_items
      (id, title, checked, sort_order, version, created_at, updated_at, deleted_at,
       owner_id, visibility, household_id, type, list_id, name, done, ordering, tag_ids)
     VALUES ('item-1', 'شیر', 0, 0, 1, ?, ?, NULL, ?, 'shared', ?,
       'listItem', 'list-1', 'شیر', 0, 0, '[]')`
  ).run(NOW, NOW, USER, HOUSEHOLD)

  const feed = db.prepare(
    `INSERT INTO change_feed
      (household_id, entity_type, entity_id, op, version, updated_at, owner_id, visibility)
     VALUES (?, ?, ?, 'upsert', ?, ?, ?, 'shared')`
  )
  const seeded: ReadonlyArray<[SyncEntityType, string, number]> = [
    ["task", "task-1", 1],
    ["note", "note-1", 2],
    ["list", "list-1", 1],
    ["listItem", "item-1", 1]
  ]
  for (const [entityType, id, version] of seeded) {
    feed.run(HOUSEHOLD, entityType, id, version, NOW, USER)
  }

  return db
}

const syncLayer = (db: DatabaseSync) => {
  const fake = new FakeD1(db)
  return SyncServiceLive.pipe(
    Layer.provide(
      D1Client.layer({
        db: fake.asD1Database(),
        transformQueryNames: Str.camelToSnake,
        transformResultNames: Str.snakeToCamel
      })
    )
  )
}

const count = (db: DatabaseSync, sql: string, ...params: ReadonlyArray<string>): number =>
  (db.prepare(sql).get(...(params as Array<string>)) as { readonly n: number }).n

describe("restore drill", () => {
  it("rebuilds a database from the nightly dump and runs the sync engine against it", async () => {
    const source = makeSource()

    // The same dump path the nightly Worker runs.
    const dump = await Effect.runPromise(
      Effect.provide(dumpDatabase, D1Client.layer({ db: new FakeD1(source).asD1Database() }))
    )

    expect(dump.sql).toContain("CREATE VIRTUAL TABLE")
    expect(dump.sql).toContain('INSERT INTO "notes_fts"')
    expect(dump.tables.find((table) => table.name === "notes")?.rows).toBe(1)
    expect(dump.tables.find((table) => table.name === "tasks")?.rows).toBe(1)

    // Restore into a genuinely empty database: the dump carries schema + data.
    const restored = new DatabaseSync(":memory:")
    restored.exec(dump.sql)

    expect(count(restored, "SELECT COUNT(*) AS n FROM tasks")).toBe(1)
    expect(count(restored, "SELECT COUNT(*) AS n FROM notes")).toBe(1)
    expect(count(restored, "SELECT COUNT(*) AS n FROM change_feed")).toBe(4)
    expect(
      count(
        restored,
        "SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH 'دارو'"
      )
    ).toBe(1)

    const layer = syncLayer(restored)
    const restoredNoteId = uuidV7()
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const sync = yield* SyncService
          const bootstrap = yield* sync.bootstrap({ userId: USER, householdId: HOUSEHOLD })
          const entry: SyncPushEntry = {
            clientMutationId: "after-restore-1",
            entityType: "note",
            entityId: restoredNoteId,
            baseVersion: 0,
            op: "upsert",
            patch: {
              title: "پس از بازیابی",
              body: null,
              plainText: "دارو",
              visibility: "shared"
            },
            clientUpdatedAt: NOW
          }
          const pushed = yield* sync.push({
            userId: USER,
            householdId: HOUSEHOLD,
            entries: [entry]
          })
          const pulled = yield* sync.pull({
            userId: USER,
            householdId: HOUSEHOLD,
            cursor: 0,
            limit: 50
          })
          return { bootstrap, pushed, pulled }
        }),
        layer
      )
    )

    const bootstrapped = result.bootstrap.items.map((item) => item.entityId)
    expect(bootstrapped).toEqual(
      expect.arrayContaining(["task-1", "note-1", "list-1", "item-1"])
    )

    const pushResult = result.pushed.results[0]
    expect(pushResult?._tag).toBe("applied")
    expect(
      result.pulled.items.find((item) => item.entityId === restoredNoteId)?.version
    ).toBe(1)

    // The registry's index hook still writes the FTS row on the restored
    // schema, so search works after the drill.
    expect(
      count(
        restored,
        "SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH 'دارو'"
      )
    ).toBe(2)
  })
})
