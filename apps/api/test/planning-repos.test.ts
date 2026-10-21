import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Effect, Layer, String as Str } from "effect"
import { D1Client } from "@effect/sql-d1"
import {
  PlanningListItem,
  Task,
  uuidV7,
  type HouseholdId,
  type ListId,
  type ListItemId,
  type TaskId,
  type UserId
} from "@tali/domain"
import { PlanningListItemRepo, PlanningListItemRepoLive, TaskRepo, TaskRepoLive } from "@tali/sql"
import { FakeD1 } from "./fake-d1.js"

/**
 * Guards the two query-level rules ticket #33's repos must honor
 * (`docs/sync-protocol-draft.md` §1.4 and the Today bucket):
 *
 * 1. `listByList` hides another member's `private` items even though the
 *    owning list is shared — a shared list may hold private rows.
 * 2. `listDueOn` orders by lifecycle/importance, not by the TEXT enum's
 *    alphabetical order (`done` < `todo`, `low` < `medium`).
 */

const MIGRATIONS = [
  "0001_list_items.sql",
  "0002_auth.sql",
  "0003_credentials.sql",
  "0003_sync_engine.sql",
  "0004_push_subscriptions.sql",
  "0005_core_planning.sql",
  "0007_task_recurrence.sql"
]

const NOW = "2026-10-20T09:30:00.000Z"
const USER_A = "user-a" as UserId
const USER_B = "user-b" as UserId
const HOUSEHOLD = "household-1" as HouseholdId

const makeHarness = () => {
  const db = new DatabaseSync(":memory:")
  const dir = new URL("../../../packages/sql/migrations/", import.meta.url)
  for (const file of MIGRATIONS) {
    db.exec(readFileSync(fileURLToPath(new URL(file, dir)), "utf8"))
  }

  const d1 = D1Client.layer({
    db: new FakeD1(db).asD1Database(),
    transformQueryNames: Str.camelToSnake,
    transformResultNames: Str.snakeToCamel
  })
  const layer = Layer.mergeAll(TaskRepoLive, PlanningListItemRepoLive).pipe(Layer.provide(d1))

  const run = <A, E>(
    effect: Effect.Effect<A, E, TaskRepo | PlanningListItemRepo>
  ): Promise<A> => Effect.runPromise(Effect.provide(effect, layer))

  return { db, run }
}

const common = {
  ownerId: USER_A,
  householdId: HOUSEHOLD,
  visibility: "shared" as const,
  color: null,
  createdAt: NOW,
  updatedAt: NOW,
  version: 1,
  deletedAt: null
}

const listItem = (input: {
  readonly id: ListItemId
  readonly listId: ListId
  readonly ownerId: UserId
  readonly visibility: "private" | "shared"
}) =>
  new PlanningListItem({
    ...common,
    ownerId: input.ownerId,
    visibility: input.visibility,
    id: input.id,
    type: "listItem",
    listId: input.listId,
    name: `item-${input.id}`,
    done: false,
    order: 1,
    checkedAt: null,
    tagIds: []
  })

const task = (input: {
  readonly id: TaskId
  readonly status: "todo" | "doing" | "done"
  readonly priority: "high" | "medium" | "low"
}) =>
  new Task({
    ...common,
    id: input.id,
    type: "task",
    title: `task-${input.id}`,
    description: null,
    status: input.status,
    priority: input.priority,
    dueAt: null,
    dueDate: "2026-10-20",
    timeZone: "UTC",
    projectId: null,
    tagIds: [],
    recurrence: null,
    recurrenceMode: null,
    startedAt: null,
    completedAt: null
  })

const id = <T>(ms: number): T => uuidV7(1_700_000_000_000 + ms) as T

describe("planning repositories: read rules", () => {
  it("listByList hides the other member's private items", async () => {
    const h = makeHarness()
    const listId = id<ListId>(1)
    const shared = listItem({
      id: id<ListItemId>(2),
      listId,
      ownerId: USER_A,
      visibility: "shared"
    })
    const ownPrivate = listItem({
      id: id<ListItemId>(3),
      listId,
      ownerId: USER_A,
      visibility: "private"
    })
    const spousePrivate = listItem({
      id: id<ListItemId>(4),
      listId,
      ownerId: USER_B,
      visibility: "private"
    })

    await h.run(
      Effect.gen(function*() {
        const repo = yield* PlanningListItemRepo
        yield* repo.insert(shared)
        yield* repo.insert(ownPrivate)
        yield* repo.insert(spousePrivate)
      })
    )

    const visible = await h.run(
      Effect.gen(function*() {
        const repo = yield* PlanningListItemRepo
        return yield* repo.listByList({ listId, householdId: HOUSEHOLD, userId: USER_A })
      })
    )
    expect(visible.map((item) => item.id).sort()).toEqual([shared.id, ownPrivate.id].sort())
  })

  it("listDueOn orders todo → doing → done, high → medium → low", async () => {
    const h = makeHarness()
    const rows = [
      task({ id: id<TaskId>(10), status: "done", priority: "high" }),
      task({ id: id<TaskId>(11), status: "todo", priority: "low" }),
      task({ id: id<TaskId>(12), status: "doing", priority: "medium" }),
      task({ id: id<TaskId>(13), status: "todo", priority: "high" })
    ]

    await h.run(
      Effect.gen(function*() {
        const repo = yield* TaskRepo
        for (const row of rows) {
          yield* repo.insert(row)
        }
      })
    )

    const due = await h.run(
      Effect.gen(function*() {
        const repo = yield* TaskRepo
        return yield* repo.listDueOn({
          householdId: HOUSEHOLD,
          userId: USER_A,
          dueDate: "2026-10-20"
        })
      })
    )
    expect(due.map((row) => [row.status, row.priority])).toEqual([
      ["todo", "high"],
      ["todo", "low"],
      ["doing", "medium"],
      ["done", "high"]
    ])
  })
})
