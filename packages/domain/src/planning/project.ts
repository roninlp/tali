import { Model } from 'effect/schema'
import { Visibility } from '../common.js'
import { commonItemFields, NonEmptyString, ProjectId } from './common.js'

/**
 * `Project` aggregate (FR-TASK-02, docs/domain-model-draft.md §3.9).
 *
 * Projects group tasks via `Task.projectId`; keeping lists flat until the UI
 * needs otherwise is the draft's settled default (open decision #11).
 *
 * Visibility is `household` (ADR-0011): both members see every project, and
 * there is no user-facing control.
 */
export class Project extends Model.Class<Project>('Project')({
  ...commonItemFields('project', ProjectId),
  visibility: Visibility,
  title: NonEmptyString,
}) {}
