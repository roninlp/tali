import { describe, expect, it } from "vitest"
import { uuidV7, type CalendarEventSource } from "@tali/domain"
import type { MirrorRecord } from "../local-store"
import {
  eventSourceFromMirror,
  overlayEventSources,
  timingOfDraft
} from "./model"

/**
 * Ticket #62's client event adapter: the calendar renders the mirror through
 * the shared domain builders, so the structural mapping and the local overlay
 * are the pieces that must not drift.
 */

const record = (input: {
  readonly id?: string
  readonly data?: Readonly<Record<string, unknown>>
  readonly updatedAt?: string
}): MirrorRecord => ({
  entityType: "event",
  entityId: input.id ?? uuidV7(),
  version: 1,
  updatedAt: input.updatedAt ?? "2026-03-21T10:00:00.000Z",
  deletedAt: null,
  data: input.data ?? {}
})

const source = (input: Partial<CalendarEventSource> & { readonly id: string }): CalendarEventSource => ({
  title: input.title ?? input.id,
  description: null,
  location: null,
  category: null,
  color: null,
  people: [],
  timing: input.timing ?? { _tag: "allDay", date: "2026-03-21" },
  timeZone: input.timeZone ?? "UTC",
  recurrence: input.recurrence ?? null,
  exceptions: input.exceptions ?? [],
  id: input.id
})

describe("event source from a mirrored row", () => {
  it("reads a locally written row", () => {
    const parsed = eventSourceFromMirror(
      record({
        data: {
          title: "سفر",
          people: ["علی"],
          timing: { _tag: "allDay", date: "2026-03-22" },
          timeZone: "Asia/Tehran",
          exceptions: []
        }
      })
    )
    expect(parsed).toMatchObject({
      title: "سفر",
      people: ["علی"],
      timing: { _tag: "allDay", date: "2026-03-22" },
      timeZone: "Asia/Tehran",
      recurrence: null
    })
  })

  it("tolerates JSON text columns and malformed values", () => {
    const parsed = eventSourceFromMirror(
      record({
        data: {
          title: "متن",
          people: "[\"سارا\"]",
          timing: "{\"_tag\":\"timed\",\"start\":\"2026-03-22T09:00:00Z\",\"end\":\"2026-03-22T10:00:00Z\"}",
          recurrence: "{\"frequency\":\"weekly\",\"interval\":1,\"end\":{\"_tag\":\"never\"}}",
          exceptions: "[]"
        },
        updatedAt: "2026-04-01T00:00:00.000Z"
      })
    )
    expect(parsed.people).toEqual(["سارا"])
    expect(parsed.timing._tag).toBe("timed")
    expect(parsed.recurrence?.frequency).toBe("weekly")

    const broken = eventSourceFromMirror(
      record({ data: { timing: "{not json" }, updatedAt: "2026-04-01T00:00:00.000Z" })
    )
    expect(broken.timing).toEqual({ _tag: "allDay", date: "2026-04-01" })
  })
})

describe("overlay", () => {
  it("merges only the pending ids over the server rows", () => {
    const server = source({ id: "one", title: "از سرور" })
    const pending = record({
      id: "one",
      data: { title: "ویرایش محلی" },
      updatedAt: "2026-03-22T00:00:00.000Z"
    })
    const other = record({
      id: "two",
      data: { title: "نوشتهٔ دیگر", timing: { _tag: "allDay", date: "2026-03-23" } }
    })

    const merged = overlayEventSources({
      base: [server],
      mirror: [pending, other],
      overlayIds: new Set(["one"])
    })
    expect(merged).toHaveLength(1)
    expect(merged[0]!.title).toBe("ویرایش محلی")
    // Fields the local patch did not carry survive the merge.
    expect(merged[0]!.timing).toEqual(server.timing)
  })

  it("drops a locally deleted series from the server snapshot", () => {
    const merged = overlayEventSources({
      base: [source({ id: "gone" }), source({ id: "stays" })],
      mirror: [],
      overlayIds: new Set(["gone"]),
      deletedIds: new Set(["gone"])
    })
    expect(merged.map((event) => event.id)).toEqual(["stays"])
  })

  it("adds a locally created event the server has not seen", () => {
    const created = record({
      id: "new",
      data: {
        title: "تازه",
        timing: { _tag: "allDay", date: "2026-03-24" },
        timeZone: "UTC"
      }
    })
    const merged = overlayEventSources({
      base: [],
      mirror: [created],
      overlayIds: new Set(["new"])
    })
    expect(merged.map((event) => event.title)).toEqual(["تازه"])
  })
})

describe("draft timing", () => {
  it("keeps an all-day draft on its local date", () => {
    expect(
      timingOfDraft({
        title: "سفر",
        date: "2026-03-22",
        allDay: true,
        startTime: "09:00",
        endTime: "10:00",
        timeZone: "Asia/Tehran"
      })
    ).toEqual({ _tag: "allDay", date: "2026-03-22" })
  })

  it("turns a wall time in the event's zone into instants", () => {
    const timing = timingOfDraft({
      title: "جلسه",
      date: "2026-03-22",
      allDay: false,
      startTime: "09:00",
      endTime: "10:30",
      timeZone: "Asia/Tehran"
    })
    expect(timing).toEqual({
      _tag: "timed",
      start: "2026-03-22T05:30:00.000Z",
      end: "2026-03-22T07:00:00.000Z"
    })
  })

  it("floors a backwards range at one hour", () => {
    const timing = timingOfDraft({
      title: "جلسه",
      date: "2026-03-22",
      allDay: false,
      startTime: "10:00",
      endTime: "09:00",
      timeZone: "UTC"
    })
    expect(timing).toEqual({
      _tag: "timed",
      start: "2026-03-22T10:00:00.000Z",
      end: "2026-03-22T11:00:00.000Z"
    })
  })
})
