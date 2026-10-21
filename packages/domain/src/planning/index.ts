/**
 * Core-planning aggregates (Slice 2 / ticket #33).
 *
 * `docs/domain-model-draft.md` §3.2–§3.9 is the source of truth for the field
 * shapes; `docs/sync-protocol-draft.md` §2 fixes the version/soft-delete
 * conventions reused here.
 */
export * from "./common"
export * from "./buckets"
export * from "./task"
export * from "./task-recurrence"
export * from "./task-service"
export * from "./project"
export * from "./tag"
export * from "./list"
export * from "./list-item"
export * from "./list-service"
export * from "./note"
export * from "./note-service"
export * from "./event"
export * from "./event-recurrence"
export * from "./event-service"
export * from "./habit"
export * from "./habit-service"
export * from "./reminder-link"
