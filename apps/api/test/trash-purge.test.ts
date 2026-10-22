import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  type SyncEntityType,
  TRASH_RETENTION_MS
} from "@tali/domain"
import {
  PURGE_MAX_ROWS_PER_AGGREGATE,
  PURGE_MAX_STATEMENTS_PER_TICK,
  TrashPurgeRepo,
  TrashPurgeRepoLive
} from "@tali/sql"
import { FakeD1 } from "./fake-d1.js"

/**
 * Ticket #85's trash purge, against D1's own engine (SQLite) through a
 * D1-shaped batch.
 *
 * The acceptance case is deliberately cross-aggregate: one old tombstone, one
 * trashed-but-recent row and one live row for every sync-registered aggregate.
 * After a sweep, only the old tombstones may be missing — from the table, the
 * feed and (for notes) the FTS index together. The extra cases pin the two
 * properties the nightly job depends on: it is idempotent, and it is bounded.
 */

const MIGRATIONS_DIR = new URL("../../../packages/sql/migrations/", import.meta.url)

const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort()

const NOW = "2026-10-23T03:17:00.000Z"
const OLD = new Date(
  Date.parse(NOW) - TRASH_RETENTION_MS - 24 * 60 * 60 * 1000
).toISOString()
const RECENT = new Date(
  Date.parse(NOW) - TRASH_RETENTION_MS + 24 * 60 * 60 * 1000
).toISOString()
const USER = "user-a"
const HOUSEHOLD = "household-a"

type DeletedAt = string | null

const insertCommon = (
  db: DatabaseSync,
  table: string,
  id: string,
  deletedAt: DeletedAt,
  createdAt: string
) => {
  db.prepare(
    `INSERT INTO ${table}
      (id, type, title, owner_id, household_id, visibility,
       created_at, updated_at, version, deleted_at)
     VALUES (?, ?, ?, ?, ?, 'shared', ?, ?, 1, ?)`
  ).run(id, table.replace(/s$/, ""), `title-${id}`, USER, HOUSEHOLD, createdAt, createdAt, deletedAt)
}

const tableOf = (entityType: SyncEntityType): string => {
  switch (entityType) {
    case "listItem":
      return "list_items"
    case "habitEntry":
      return "habit_entries"
    case "tag":
      return "tags"
    default:
      return `${entityType}s`
  }
}

const seedRow = (
  db: DatabaseSync,
  entityType: SyncEntityType,
  id: string,
  deletedAt: DeletedAt
): void => {
  const createdAt = "2025-01-01T00:00:00.000Z"
  switch (entityType) {
    case "project":
    case "task":
    case "list":
    case "event":
      insertCommon(db, `${entityType}s`, id, deletedAt, createdAt)
      return
    case "occasion":
      db.prepare(
        `INSERT INTO occasions
          (id, title, owner_id, household_id, visibility, origin_date, time_zone,
           yearly, created_at, updated_at, version, deleted_at)
         VALUES (?, ?, ?, ?, 'shared', '1990-01-01', 'UTC', 1, ?, ?, 1, ?)`
      ).run(id, `title-${id}`, USER, HOUSEHOLD, createdAt, createdAt, deletedAt)
      return
    case "tag":
      db.prepare(
        `INSERT INTO tags (id, name, owner_id, household_id, visibility,
          created_at, updated_at, version, deleted_at)
         VALUES (?, ?, ?, ?, 'shared', ?, ?, 1, ?)`
      ).run(id, `name-${id}`, USER, HOUSEHOLD, createdAt, createdAt, deletedAt)
      return
    case "listItem":
      db.prepare(
        `INSERT INTO list_items
          (id, title, checked, sort_order, version, created_at, updated_at, deleted_at,
           owner_id, visibility, household_id, type, name, done, ordering, tag_ids)
         VALUES (?, ?, 0, 0, 1, ?, ?, ?, ?, 'shared', ?, 'listItem', ?, 0, 0, '[]')`
      ).run(id, `title-${id}`, createdAt, createdAt, deletedAt, USER, HOUSEHOLD, `title-${id}`)
      return
    case "note":
      db.prepare(
        `INSERT INTO notes
          (id, title, body, plain_text, owner_id, household_id, visibility,
           is_pinned, is_archived, tag_ids, created_at, updated_at, version, deleted_at)
         VALUES (?, ?, NULL, ?, ?, ?, 'shared', 0, 0, '[]', ?, ?, 1, ?)`
      ).run(id, `title-${id}`, `body-${id}`, USER, HOUSEHOLD, createdAt, createdAt, deletedAt)
      db.prepare(
        `INSERT INTO notes_fts (note_id, search_title, search_body) VALUES (?, ?, ?)`
      ).run(id, `title-${id}`, `body-${id}`)
      return
    case "habit":
      db.prepare(
        `INSERT INTO habits
          (id, title, owner_id, household_id, visibility, started_on,
           frequency, frequency_history, time_zone,
           created_at, updated_at, version, deleted_at)
         VALUES (?, ?, ?, ?, 'shared', '2025-01-01', '{"_tag":"daily"}', '[]', 'UTC', ?, ?, 1, ?)`
      ).run(id, `title-${id}`, USER, HOUSEHOLD, createdAt, createdAt, deletedAt)
      return
    case "habitEntry": {
      const habitId = `habit-${id}`
      seedRow(db, "habit", habitId, null)
      db.prepare(
        `INSERT INTO habit_entries
          (id, habit_id, owner_id, household_id, visibility, local_date, time_zone,
           status, created_at, updated_at, version, deleted_at)
         VALUES (?, ?, ?, ?, 'shared', '2025-01-01', 'UTC', 'done', ?, ?, 1, ?)`
      ).run(id, habitId, USER, HOUSEHOLD, createdAt, createdAt, deletedAt)
      return
    }
    case "reminder":
      db.prepare(
        `INSERT INTO reminders
          (id, title, owner_id, household_id, visibility, kind, tier, repeat,
           fire_at, time_zone, created_at, updated_at, version, deleted_at)
         VALUES (?, ?, ?, ?, 'shared', 'general', 'normal', '{"_tag":"once"}',
           ?, 'UTC', ?, ?, 1, ?)`
      ).run(id, `title-${id}`, USER, HOUSEHOLD, createdAt, createdAt, createdAt, deletedAt)
      return
  }
}

const insertFeed = (db: DatabaseSync, entityType: SyncEntityType, id: string): void => {
  db.prepare(
    `INSERT INTO change_feed
      (household_id, entity_type, entity_id, op, version, updated_at, owner_id, visibility)
     VALUES (?, ?, ?, 'delete', 1, ?, ?, 'shared')`
  ).run(HOUSEHOLD, entityType, id, NOW, USER)
}

const countWhere = (db: DatabaseSync, sql: string, ...params: ReadonlyArray<unknown>): number =>
  (db.prepare(sql).get(...(params as Array<string>)) as { readonly n: number }).n

const makeHarness = () => {
  const db = new DatabaseSync(":memory:")
  for (const file of migrationFiles()) {
    db.exec(readFileSync(fileURLToPath(new URL(file, MIGRATIONS_DIR)), "utf8"))
  }
  const fake = new FakeD1(db)
  const d1 = D1Client.layer({ db: fake.asD1Database() })
  const layer = TrashPurgeRepoLive.pipe(Layer.provide(d1))
  const purge = (now: string) =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const repo = yield* TrashPurgeRepo
          return yield* repo.purge(now)
        }),
        layer
      )
    )
  return { db, fake, purge }
}

const ENTITIES: ReadonlyArray<SyncEntityType> = [
  "task",
  "project",
  "tag",
  "list",
  "listItem",
  "note",
  "event",
  "habit",
  "habitEntry",
  "reminder",
  "occasion"
]

describe("trash purge", () => {
  it("removes old tombstones from rows, feed and search; recent and live rows survive", async () => {
    const h = makeHarness()
    for (const entityType of ENTITIES) {
      seedRow(h.db, entityType, `old-${entityType}`, OLD)
      seedRow(h.db, entityType, `recent-${entityType}`, RECENT)
      seedRow(h.db, entityType, `live-${entityType}`, null)
      insertFeed(h.db, entityType, `old-${entityType}`)
      insertFeed(h.db, entityType, `recent-${entityType}`)
      insertFeed(h.db, entityType, `live-${entityType}`)
    }

    // Join rows on both sides: an old tag's assignments and an old item's
    // assignments must both disappear with the row.
    h.db.exec(`
      INSERT INTO item_tags (item_id, item_type, tag_id, household_id, created_at) VALUES
        ('old-task', 'task', 'old-tag', '${HOUSEHOLD}', '${NOW}'),
        ('live-task', 'task', 'live-tag', '${HOUSEHOLD}', '${NOW}'),
        ('old-note', 'note', 'old-tag', '${HOUSEHOLD}', '${NOW}')
    `)

    const result = await h.purge(NOW)

    expect(result.purged).toBe(ENTITIES.length)
    expect(result.statements).toBeLessThanOrEqual(PURGE_MAX_STATEMENTS_PER_TICK)
    expect(result.capped).toBe(false)

    for (const entityType of ENTITIES) {
      const table = tableOf(entityType)
      expect(
        countWhere(h.db, `SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`, `old-${entityType}`)
      ).toBe(0)
      expect(
        countWhere(h.db, `SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`, `recent-${entityType}`)
      ).toBe(1)
      expect(
        countWhere(h.db, `SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`, `live-${entityType}`)
      ).toBe(1)

      expect(
        countWhere(
          h.db,
          "SELECT COUNT(*) AS n FROM change_feed WHERE entity_id = ?",
          `old-${entityType}`
        )
      ).toBe(0)
      expect(
        countWhere(
          h.db,
          "SELECT COUNT(*) AS n FROM change_feed WHERE entity_id = ?",
          `recent-${entityType}`
        )
      ).toBe(1)
      expect(
        countWhere(
          h.db,
          "SELECT COUNT(*) AS n FROM change_feed WHERE entity_id = ?",
          `live-${entityType}`
        )
      ).toBe(1)
    }

    expect(
      countWhere(h.db, "SELECT COUNT(*) AS n FROM notes_fts WHERE note_id = ?", "old-note")
    ).toBe(0)
    expect(
      countWhere(h.db, "SELECT COUNT(*) AS n FROM notes_fts WHERE note_id = ?", "recent-note")
    ).toBe(1)
    expect(
      countWhere(h.db, "SELECT COUNT(*) AS n FROM notes_fts WHERE note_id = ?", "live-note")
    ).toBe(1)

    expect(
      countWhere(h.db, "SELECT COUNT(*) AS n FROM item_tags WHERE item_id = 'old-task'")
    ).toBe(0)
    expect(
      countWhere(h.db, "SELECT COUNT(*) AS n FROM item_tags WHERE item_id = 'old-note'")
    ).toBe(0)
    expect(
      countWhere(h.db, "SELECT COUNT(*) AS n FROM item_tags WHERE tag_id = 'old-tag'")
    ).toBe(0)
    expect(
      countWhere(h.db, "SELECT COUNT(*) AS n FROM item_tags WHERE item_id = 'live-task'")
    ).toBe(1)
  })

  it("is idempotent: a second sweep at the same instant changes nothing", async () => {
    const h = makeHarness()
    seedRow(h.db, "note", "old-note", OLD)
    insertFeed(h.db, "note", "old-note")

    const first = await h.purge(NOW)
    expect(first.purged).toBe(1)
    const feedAfterFirst = countWhere(h.db, "SELECT COUNT(*) AS n FROM change_feed")

    const second = await h.purge(NOW)
    expect(second.purged).toBe(0)
    expect(second.entities).toEqual([])
    expect(countWhere(h.db, "SELECT COUNT(*) AS n FROM change_feed")).toBe(feedAfterFirst)
    expect(countWhere(h.db, "SELECT COUNT(*) AS n FROM notes WHERE id = 'old-note'")).toBe(0)
  })

  it("is bounded per tick: a backlog drains over successive sweeps under D1's ceiling", async () => {
    const h = makeHarness()
    for (let index = 0; index < PURGE_MAX_ROWS_PER_AGGREGATE + 20; index += 1) {
      const id = `old-note-${index}`
      seedRow(h.db, "note", id, OLD)
      insertFeed(h.db, "note", id)
    }

    const first = await h.purge(NOW)
    expect(first.purged).toBe(PURGE_MAX_ROWS_PER_AGGREGATE)
    expect(first.capped).toBe(true)
    expect(first.statements).toBeLessThanOrEqual(PURGE_MAX_STATEMENTS_PER_TICK)
    expect(h.fake.statementCalls).toBeLessThanOrEqual(PURGE_MAX_STATEMENTS_PER_TICK)

    const second = await h.purge(NOW)
    expect(second.purged).toBe(20)
    expect(second.capped).toBe(false)

    const third = await h.purge(NOW)
    expect(third.purged).toBe(0)
    expect(countWhere(h.db, "SELECT COUNT(*) AS n FROM notes")).toBe(0)
    expect(countWhere(h.db, "SELECT COUNT(*) AS n FROM notes_fts")).toBe(0)
  })

  it("never deletes a row restored between the selection read and the batch", async () => {
    const h = makeHarness()
    seedRow(h.db, "task", "restored-task", OLD)
    insertFeed(h.db, "task", "restored-task")

    let restored = false
    h.fake.beforeBatch = () => {
      if (restored) return
      restored = true
      h.db.exec("UPDATE tasks SET deleted_at = NULL WHERE id = 'restored-task'")
    }

    const result = await h.purge(NOW)
    expect(result.purged).toBe(0)
    expect(
      countWhere(h.db, "SELECT COUNT(*) AS n FROM tasks WHERE id = 'restored-task'")
    ).toBe(1)
    expect(
      countWhere(
        h.db,
        "SELECT COUNT(*) AS n FROM change_feed WHERE entity_id = 'restored-task'"
      )
    ).toBe(1)
  })
})
