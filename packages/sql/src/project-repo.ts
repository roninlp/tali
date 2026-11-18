import { Context, Effect, Layer, Option } from 'effect'
import { SqlClient } from 'effect/sql'
import { Project, type ProjectId, type UserId } from '@tali/domain'
import {
  type ColumnValues,
  column,
  columnCodecs,
  defineTable,
  insertStatement,
  selectList,
  updateStatement,
} from './columns'
import { visibleScopeSql } from './scope'

/**
 * D1-backed repository for `Project` (ticket #33; FR-TASK-02). Pure persistence.
 */

/**
 * The one place `projects`' columns are declared (#115): the repo's SELECT,
 * INSERT and UPDATE lists below, and the sync registry's projection and
 * statements, are all generated from this descriptor.
 */
export const PROJECT_TABLE = defineTable('projects', [
  column('id', { updatable: false }),
  column('type', { updatable: false }),
  column('title', { codec: columnCodecs.text }),
  column('owner_id', 'ownerId', { updatable: false }),
  column('household_id', 'householdId', { updatable: false }),
  column('visibility'),
  column('color', { codec: columnCodecs.nullableText }),
  column('created_at', 'createdAt', {
    updatable: false,
    codec: columnCodecs.text,
  }),
  column('updated_at', 'updatedAt', { codec: columnCodecs.text }),
  column('version', { codec: columnCodecs.int }),
  column('deleted_at', 'deletedAt', { codec: columnCodecs.nullableText }),
])

const PROJECT_SELECT = selectList(PROJECT_TABLE)

/** The model's column values; the descriptor's codecs do the encoding. */
const projectValues = (project: Project): ColumnValues<typeof PROJECT_TABLE> => ({
  id: project.id,
  type: project.type,
  title: project.title,
  ownerId: project.ownerId,
  householdId: project.householdId,
  visibility: project.visibility,
  color: project.color,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  version: project.version,
  deletedAt: project.deletedAt,
})

export class ProjectRepo extends Context.Service<ProjectRepo>()('ProjectRepo', {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const findById = (id: ProjectId) =>
      Effect.map(
        sql<Project>`SELECT ${sql.literal(PROJECT_SELECT)} FROM projects WHERE id = ${id}`,
        rows => Option.fromUndefinedOr(rows[0]),
      )

    const listVisible = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<Project>`
          SELECT ${sql.literal(PROJECT_SELECT)} FROM projects
          WHERE ${visibleScopeSql(sql, input)}
          ORDER BY title ASC, id ASC
        `,
        rows => rows,
      )

    const insert = (project: Project) =>
      Effect.map(
        insertStatement<Project>(sql, PROJECT_TABLE, {
          values: projectValues(project),
          returning: PROJECT_SELECT,
        }),
        rows => rows[0]!,
      )

    const update = (project: Project) =>
      Effect.map(
        updateStatement<Project>(sql, PROJECT_TABLE, {
          id: project.id,
          values: projectValues(project),
          returning: PROJECT_SELECT,
        }),
        rows => Option.fromUndefinedOr(rows[0]),
      )

    return { findById, listVisible, insert, update }
  }),
}) {}

export const ProjectRepoLive = Layer.effect(ProjectRepo, ProjectRepo.make)
