import { Schema } from "effect"
import { Model } from "effect/schema"
import { commonItemFields, ProjectId } from "./common.js"

/**
 * `Project` aggregate (FR-TASK-02, docs/domain-model-draft.md §3.9).
 *
 * Projects group tasks via `Task.projectId`; keeping lists flat until the UI
 * needs otherwise is the draft's settled default (open decision #11).
 */
export class Project extends Model.Class<Project>("Project")({
  ...commonItemFields("project", ProjectId),
  title: Schema.String.check(Schema.isMinLength(1))
}) {}

export const ProjectCreate = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1))
})
export type ProjectCreate = Schema.Schema.Type<typeof ProjectCreate>
