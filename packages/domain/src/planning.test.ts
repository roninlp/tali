import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import type { HouseholdId, UserId } from "./common.js"
import { uuidV7 } from "./ids.js"
import {
  List,
  ListItem,
  Note,
  Project,
  Tag,
  Task,
  TaskCreate
} from "./planning/index.js"
import type {
  ListId,
  ListItemId,
  NoteId,
  ProjectId,
  TagId,
  TaskId
} from "./planning/common.js"
import { SyncEntityType } from "./sync.js"

/**
 * Ticket #33 exit criterion: every core-planning aggregate round-trips through
 * its Schema model, and malformed payloads are rejected at the edge.
 *
 * These are pure codec tests — no SQL — so they pin the domain contract that
 * the repos and the later RPC/sync services consume.
 */

const NOW = "2026-10-20T09:30:00.000Z"
const USER = "user-1" as UserId
const HOUSEHOLD = "household-1" as HouseholdId
const projectId = uuidV7(1_700_000_000_000) as ProjectId
const tagId = uuidV7(1_700_000_000_001) as TagId
const listId = uuidV7(1_700_000_000_002) as ListId

const common = {
  ownerId: USER,
  householdId: HOUSEHOLD,
  visibility: "shared" as const,
  color: null,
  createdAt: NOW,
  updatedAt: NOW,
  version: 4,
  deletedAt: null
}

const task = {
  ...common,
  id: uuidV7(1_700_000_000_010) as TaskId,
  type: "task" as const,
  title: "خرید نان",
  description: null,
  status: "doing" as const,
  priority: "high" as const,
  dueAt: null,
  dueDate: "2026-10-20",
  timeZone: "Asia/Tehran",
  projectId,
  tagIds: [tagId],
  startedAt: NOW,
  completedAt: null
}

const project = {
  ...common,
  id: uuidV7(1_700_000_000_011) as ProjectId,
  type: "project" as const,
  title: "خانه"
}

const tag = {
  ...common,
  id: tagId,
  type: "tag" as const,
  name: "فوری"
}

const list = {
  ...common,
  id: listId,
  type: "list" as const,
  title: "هفتگی",
  description: null,
  icon: "list",
  sort: "manual" as const,
  checkedPlacement: "bottom" as const
}

const listItem = {
  ...common,
  id: uuidV7(1_700_000_000_012) as ListItemId,
  type: "listItem" as const,
  listId,
  name: "شیر",
  done: false,
  order: 2,
  checkedAt: null,
  tagIds: [tagId]
}

const note = {
  ...common,
  id: uuidV7(1_700_000_000_013) as NoteId,
  type: "note" as const,
  title: "ایده",
  body: { type: "doc", content: [{ type: "paragraph" }] },
  plainText: "ایده",
  isPinned: true,
  isArchived: false,
  tagIds: [tagId]
}

/** Decode, re-encode and compare with the exact payload the DB/wire sends. */
const roundTrip = <A extends Schema.Top>(
  schema: A,
  payload: Schema.Schema.Type<A>
): Schema.Schema.Type<A> => {
  const decoded = Schema.decodeUnknownSync(schema as any)(payload)
  expect(Schema.encodeSync(schema as any)(decoded)).toEqual(payload)
  return decoded as Schema.Schema.Type<A>
}

describe("core-planning aggregate schemas", () => {
  it("round-trips Task", () => {
    const decoded = roundTrip(Task, task)
    expect(decoded).toBeInstanceOf(Task)
    expect(decoded.title).toBe("خرید نان")
    expect(decoded.status).toBe("doing")
  })

  it("round-trips Project", () => {
    roundTrip(Project, project)
  })

  it("round-trips Tag", () => {
    roundTrip(Tag, tag)
  })

  it("round-trips List", () => {
    roundTrip(List, list)
  })

  it("round-trips ListItem", () => {
    const decoded = roundTrip(ListItem, listItem)
    expect(decoded.listId).toBe(listId)
    expect(decoded.order).toBe(2)
    expect(decoded.checkedAt).toBeNull()
  })

  it("round-trips Note with structured JSON body", () => {
    const decoded = roundTrip(Note, note)
    expect(decoded.body).toEqual(note.body)
    expect(decoded.isPinned).toBe(true)
  })

  it("accepts a task created with title only", () => {
    const input = Schema.decodeUnknownSync(TaskCreate)({ title: "تنها عنوان" })
    expect(input).toEqual({ title: "تنها عنوان" })
  })

  it("keeps the sync discriminator aligned with ItemType", () => {
    expect(SyncEntityType.literals).toEqual(
      expect.arrayContaining(["task", "project", "tag", "list", "listItem", "note"])
    )
  })
})

describe("core-planning schema validation", () => {
  it("rejects a Task without a title", () => {
    const { title: _title, ...payload } = task
    expect(() => Schema.decodeUnknownSync(Task)(payload)).toThrow()
  })

  it("rejects an empty Task title", () => {
    expect(() => Schema.decodeUnknownSync(Task)({ ...task, title: "" })).toThrow()
  })

  it("rejects an unknown Task status", () => {
    expect(() => Schema.decodeUnknownSync(Task)({ ...task, status: "archived" })).toThrow()
  })

  it("rejects an unknown priority", () => {
    expect(() => Schema.decodeUnknownSync(Task)({ ...task, priority: "urgent" })).toThrow()
  })

  it("rejects a non-integer version", () => {
    expect(() => Schema.decodeUnknownSync(Task)({ ...task, version: 1.5 })).toThrow()
  })

  it("rejects a malformed or non-v7 id", () => {
    expect(() => Schema.decodeUnknownSync(Task)({ ...task, id: "not-a-uuid" })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Task)({ ...task, id: "00000000-0000-4000-8000-000000000000" })
    ).toThrow()
  })

  it("rejects a wrong discriminator", () => {
    expect(() => Schema.decodeUnknownSync(Task)({ ...task, type: "note" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Project)({ ...project, type: "task" })).toThrow()
  })

  it("rejects an invalid all-day date", () => {
    expect(() => Schema.decodeUnknownSync(Task)({ ...task, dueDate: "1403/07/28" })).toThrow()
  })

  it("rejects an unknown IANA time zone", () => {
    expect(() => Schema.decodeUnknownSync(Task)({ ...task, timeZone: "Mars/Olympus" })).toThrow()
  })

  it("rejects a ListItem without its list", () => {
    const { listId: _listId, ...payload } = listItem
    expect(() => Schema.decodeUnknownSync(ListItem)(payload)).toThrow()
  })

  it("rejects a non-boolean Note flag", () => {
    expect(() => Schema.decodeUnknownSync(Note)({ ...note, isPinned: "yes" })).toThrow()
  })

  it("rejects too many tags-worth of wrong type", () => {
    expect(() => Schema.decodeUnknownSync(Task)({ ...task, tagIds: [123] })).toThrow()
  })
})
