import { describe, expect, it } from "vitest"
import type { Statement } from "effect/sql"
import type { SyncEntityType } from "@tali/domain"
import {
  chunkWriteGroups,
  MAX_BATCH_STATEMENTS,
  orderWriteGroups
} from "../src/sync-service.js"

/**
 * The push chunker is the only thing standing between a 200-entry catch-up and
 * one ~1,000-statement `d1.batch()`. These are pure tests of that split: the
 * budget counts *every* statement a group carries (row, feed, ledger, derived
 * index, recurrence spawn), a group is never broken up, and the parent-before-
 * child ordering is established over the whole push before any chunking.
 */

const statement = {} as Statement.Statement<unknown>

const group = (entityType: SyncEntityType, size: number, label: string) => ({
  label,
  state: { entityType },
  statements: Array.from({ length: size }, () => statement)
})

const statementCount = (groups: ReadonlyArray<{ readonly statements: ReadonlyArray<unknown> }>) =>
  groups.reduce((total, current) => total + current.statements.length, 0)

/** Note group: row + feed + ledger + the FTS delete and insert. */
const NOTE_STATEMENTS = 5
/** Read-only task group: row + feed + ledger. */
const TASK_STATEMENTS = 3

describe("push statement chunker", () => {
  it("holds a 200-note push to MAX_BATCH_STATEMENTS per batch", () => {
    // The reported failure mode: 200 notes × (row + feed + ledger + 2 FTS
    // statements) = 1,000 statements in what used to be one batch.
    const groups = Array.from({ length: 200 }, (_, index) =>
      group("note", NOTE_STATEMENTS, `note-${index}`)
    )

    const chunks = chunkWriteGroups(groups)

    expect(statementCount(groups)).toBe(1_000)
    expect(chunks).toHaveLength(Math.ceil(1_000 / MAX_BATCH_STATEMENTS))
    for (const chunk of chunks) {
      expect(statementCount(chunk)).toBeLessThanOrEqual(MAX_BATCH_STATEMENTS)
    }
  })

  it("counts index and spawn statements, and never splits a group", () => {
    const groups = [
      group("project", 3, "project"),
      // A note: row + feed + ledger + FTS delete + FTS insert.
      group("note", 5, "note"),
      // A completed recurring task: its own triple plus a spawned child's
      // insert/feed/ledger and tag joins.
      group("task", 12, "task-with-spawn"),
      group("habit", 3, "habit"),
      group("habitEntry", 3, "habitEntry")
    ]

    const chunks = chunkWriteGroups(groups, 4)

    // Every group appears exactly once, in order, and a group larger than the
    // budget still sits alone rather than being cut in half.
    expect(chunks.flat().map((entry) => entry.label)).toEqual(groups.map((entry) => entry.label))
    expect(chunks).toHaveLength(5)
    expect(chunks.map((chunk) => chunk.map((entry) => entry.label))).toEqual([
      ["project"],
      ["note"],
      ["task-with-spawn"],
      ["habit"],
      ["habitEntry"]
    ])
  })

  it("orders parents before children globally, across chunk boundaries", () => {
    // Deliberately interleaved input: the push planner emits groups in wire
    // order, and a dependent row may arrive before its parent.
    const groups = [
      group("note", NOTE_STATEMENTS, "note-0"),
      group("project", 3, "project"),
      group("habitEntry", 3, "habitEntry"),
      group("note", NOTE_STATEMENTS, "note-1"),
      group("tag", 3, "tag"),
      group("task", TASK_STATEMENTS, "task-0"),
      group("habit", 3, "habit"),
      group("task", TASK_STATEMENTS, "task-1"),
      group("listItem", 3, "listItem")
    ]

    const ordered = orderWriteGroups(groups)
    // A budget this small forces a boundary between nearly every group, so
    // the invariant has to survive chunking, not just sorting.
    const chunks = chunkWriteGroups(ordered, 4)
    const flattened = chunks.flat()

    expect(flattened.map((entry) => entry.label)).toEqual([
      "project",
      "tag",
      "habit",
      "note-0",
      "habitEntry",
      "note-1",
      "task-0",
      "task-1",
      "listItem"
    ])
    // Parent-before-child holds globally: every rank-0 group is in an earlier
    // chunk than every rank-1 group.
    const rankZero = ["project", "tag", "habit"]
    const lastParentChunk = chunks.findLastIndex((chunk) =>
      chunk.some((entry) => rankZero.includes(entry.label))
    )
    const firstChildChunk = chunks.findIndex((chunk) =>
      chunk.some((entry) => !rankZero.includes(entry.label))
    )
    expect(lastParentChunk).toBeLessThan(firstChildChunk)
    // Same-type FIFO order survives the stable sort and the split.
    const notes = flattened.filter((entry) => entry.label.startsWith("note-")).map((entry) => entry.label)
    expect(notes).toEqual(["note-0", "note-1"])
  })

  it("returns no batches for an empty push", () => {
    expect(chunkWriteGroups([])).toEqual([])
    expect(orderWriteGroups([])).toEqual([])
  })
})
