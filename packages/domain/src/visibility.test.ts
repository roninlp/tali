import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  ListCreateInput,
  ListItemCreateInput,
  NoteCreateInput,
  ProjectCreateInput,
  TagCreateInput,
  TaskCreateInput
} from "./planning/index.js"
import {
  VISIBILITY_POLICY,
  defaultVisibilityFor,
  isShareableVisibility,
  resolveCreateVisibility,
  resolveInheritedVisibility,
  visibilityPolicyOf
} from "./visibility.js"

/**
 * ADR-0011: the per-aggregate visibility policy is the single source of truth,
 * and only the `shareable` class accepts a user value.
 */

describe("the per-aggregate visibility table", () => {
  it("classifies every aggregate into one of the four classes", () => {
    expect(visibilityPolicyOf("userPreferences")._tag).toBe("ownerOnly")
    expect(visibilityPolicyOf("session")._tag).toBe("ownerOnly")
    expect(visibilityPolicyOf("pushSubscription")._tag).toBe("ownerOnly")
    expect(visibilityPolicyOf("reminderDispatch")._tag).toBe("ownerOnly")

    expect(visibilityPolicyOf("habitEntry")).toEqual({ _tag: "inherited", parent: "habit" })
    expect(visibilityPolicyOf("listItem")).toEqual({ _tag: "inherited", parent: "list" })

    expect(visibilityPolicyOf("project")._tag).toBe("household")
    expect(visibilityPolicyOf("tag")._tag).toBe("household")
  })

  it("gives shareable aggregates exactly one default", () => {
    expect(VISIBILITY_POLICY.list).toEqual({ _tag: "shareable", default: "shared" })
    expect(VISIBILITY_POLICY.event).toEqual({ _tag: "shareable", default: "shared" })
    expect(VISIBILITY_POLICY.task).toEqual({ _tag: "shareable", default: "shared" })
    expect(VISIBILITY_POLICY.note).toEqual({ _tag: "shareable", default: "private" })
    expect(VISIBILITY_POLICY.habit).toEqual({ _tag: "shareable", default: "private" })
    expect(VISIBILITY_POLICY.reminder).toEqual({ _tag: "shareable", default: "private" })
    expect(VISIBILITY_POLICY.occasion).toEqual({ _tag: "shareable", default: "private" })
  })

  it("reports which aggregates own a user-facing control", () => {
    const shareable = [
      "list",
      "event",
      "task",
      "note",
      "habit",
      "reminder",
      "occasion"
    ].filter((aggregate) => isShareableVisibility(aggregate as never))

    expect(shareable).toEqual([
      "list",
      "event",
      "task",
      "note",
      "habit",
      "reminder",
      "occasion"
    ])
    expect(isShareableVisibility("project")).toBe(false)
    expect(isShareableVisibility("listItem")).toBe(false)
    expect(isShareableVisibility("reminderDispatch")).toBe(false)
  })
})

describe("resolved create visibility", () => {
  it("always resolves owner-only rows to private", () => {
    expect(defaultVisibilityFor("session")).toBe("private")
    expect(resolveCreateVisibility("userPreferences")).toBe("private")
    expect(resolveCreateVisibility("pushSubscription", "shared")).toBe("private")
    expect(resolveCreateVisibility("reminderDispatch", "shared")).toBe("private")
  })

  it("always resolves household rows to shared", () => {
    expect(defaultVisibilityFor("project")).toBe("shared")
    expect(resolveCreateVisibility("tag")).toBe("shared")
    expect(resolveCreateVisibility("project", "private")).toBe("shared")
  })

  it("uses the aggregate default unless the user chooses", () => {
    expect(resolveCreateVisibility("note")).toBe("private")
    expect(resolveCreateVisibility("note", "shared")).toBe("shared")
    expect(resolveCreateVisibility("task")).toBe("shared")
    expect(resolveCreateVisibility("task", "private")).toBe("private")
    expect(resolveCreateVisibility("occasion")).toBe("private")
    expect(resolveCreateVisibility("event")).toBe("shared")
  })

  it("refuses to invent a value for an inherited row", () => {
    expect(() => resolveCreateVisibility("habitEntry")).toThrow(/inherits visibility/)
    expect(defaultVisibilityFor("habitEntry")).toBe("private")
    expect(defaultVisibilityFor("listItem")).toBe("shared")
  })
})

describe("inherited resolution", () => {
  it("copies the parent when the child has no opinion", () => {
    expect(resolveInheritedVisibility("habitEntry", "private")).toEqual({
      _tag: "resolved",
      visibility: "private"
    })
    expect(resolveInheritedVisibility("listItem", "shared")).toEqual({
      _tag: "resolved",
      visibility: "shared"
    })
  })

  it("never lets a child be wider than its parent", () => {
    expect(resolveInheritedVisibility("habitEntry", "private", "shared")).toEqual({
      _tag: "refused"
    })
    expect(resolveInheritedVisibility("listItem", "private", "shared")).toEqual({
      _tag: "refused"
    })
  })

  it("refuses an independent value on an exact-inheritance child", () => {
    expect(resolveInheritedVisibility("habitEntry", "shared", "private")).toEqual({
      _tag: "refused"
    })
  })

  it("allows a narrower list item inside a shared list", () => {
    expect(resolveInheritedVisibility("listItem", "shared", "private")).toEqual({
      _tag: "resolved",
      visibility: "private"
    })
  })
})

describe("create schemas only accept visibility where the policy is shareable", () => {
  it("strips visibility from project, tag and list-item creates", () => {
    expect(
      Schema.decodeUnknownSync(ProjectCreateInput)({
        clientMutationId: "m1",
        title: "خانه",
        visibility: "private"
      })
    ).not.toHaveProperty("visibility")

    expect(
      Schema.decodeUnknownSync(TagCreateInput)({
        clientMutationId: "m2",
        name: "کار",
        visibility: "private"
      })
    ).not.toHaveProperty("visibility")

    expect(
      Schema.decodeUnknownSync(ListItemCreateInput)({
        clientMutationId: "m3",
        listId: "0198c9a0-0000-7000-8000-000000000001",
        name: "نان",
        visibility: "private"
      })
    ).not.toHaveProperty("visibility")
  })

  it("keeps visibility on the shareable creates", () => {
    expect(
      Schema.decodeUnknownSync(NoteCreateInput)({
        clientMutationId: "m4",
        visibility: "shared"
      })
    ).toMatchObject({ visibility: "shared" })

    expect(
      Schema.decodeUnknownSync(ListCreateInput)({
        clientMutationId: "m5",
        title: "خرید",
        visibility: "private"
      })
    ).toMatchObject({ visibility: "private" })

    expect(
      Schema.decodeUnknownSync(TaskCreateInput)({
        clientMutationId: "m6",
        title: "تماس",
        visibility: "private"
      })
    ).toMatchObject({ visibility: "private" })
  })
})
